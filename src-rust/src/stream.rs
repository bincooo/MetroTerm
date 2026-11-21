//! Byte-stream terminals: Telnet (RFC 854 with ECHO / SGA / BINARY / TTYPE / NAWS), raw TCP and
//! serial ports. The UI sees them like any other terminal (`TerminalData` / `TerminalExit`).

use crate::{
    events::Event,
    ssh::{ConnectionSpec, Shared, Transport},
    terminal::TERM,
    utf8::Utf8Stream,
};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

pub enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Write side of a stream terminal (the reader runs on its own task / thread).
pub struct StreamHandle {
    pub input: mpsc::UnboundedSender<Input>,
}

/// Called once when the stream ends: (exit reason).
pub type OnExit = Box<dyn FnOnce(Option<String>) + Send>;

/// Emits decoded output for one terminal; with local echo, typed input is shown as well.
struct Output {
    shared: Arc<Shared>,
    session_id: String,
    decoder: Utf8Stream,
}

impl Output {
    fn emit(&mut self, bytes: &[u8]) {
        let data = self.decoder.decode(bytes);
        self.send(data);
    }
    fn finish(&mut self) {
        let data = self.decoder.finish();
        self.send(data);
    }
    fn send(&self, data: String) {
        if !data.is_empty() {
            self.shared.sink.emit(Event::TerminalData {
                session_id: self.session_id.clone(),
                data,
            });
        }
    }
    /// Local echo of typed input (Enter → new line, Backspace erases).
    fn echo(&self, bytes: &[u8]) {
        let mut text = String::new();
        for ch in String::from_utf8_lossy(bytes).chars() {
            match ch {
                '\r' => text.push_str("\r\n"),
                '\u{7f}' | '\u{8}' => text.push_str("\u{8} \u{8}"),
                ch if ch < ' ' && ch != '\n' && ch != '\t' => {}
                ch => text.push(ch),
            }
        }
        self.send(text);
    }
}

pub async fn start(
    shared: &Arc<Shared>,
    session_id: &str,
    spec: &ConnectionSpec,
    cols: u16,
    rows: u16,
    on_exit: OnExit,
) -> Result<StreamHandle, String> {
    let output = Output {
        shared: shared.clone(),
        session_id: session_id.to_owned(),
        decoder: Utf8Stream::default(),
    };
    let (input, receiver) = mpsc::unbounded_channel();
    match spec.transport {
        Transport::Serial => start_serial(spec, output, receiver, on_exit)?,
        Transport::Telnet | Transport::Tcp => {
            let host = spec.host.trim();
            if host.is_empty() {
                return Err("Session has no host".into());
            }
            if spec.transport == Transport::Tcp && spec.port == 0 {
                return Err("TCP session has no port".into());
            }
            log::info!("{:?} connect {}", spec.transport, spec.label());
            let socket = crate::net::connect(host, spec.port(), spec.proxy().as_ref()).await?;
            let telnet = spec.transport == Transport::Telnet;
            let echo = spec.local_echo;
            tokio::spawn(async move {
                let reason = if telnet {
                    run_telnet(socket, output, receiver, cols, rows, echo).await
                } else {
                    run_tcp(socket, output, receiver, echo).await
                };
                on_exit(reason);
            });
        }
        _ => return Err("Not a stream session".into()),
    }
    Ok(StreamHandle { input })
}

// ---------------------------------------------------------------- raw TCP

async fn run_tcp(
    socket: tokio::net::TcpStream,
    mut output: Output,
    mut input: mpsc::UnboundedReceiver<Input>,
    echo: bool,
) -> Option<String> {
    let (mut read, mut write) = socket.into_split();
    let mut buffer = vec![0_u8; 16 * 1024];
    let reason = loop {
        tokio::select! {
            result = read.read(&mut buffer) => match result {
                Ok(0) => break Some("Connection closed by peer".to_owned()),
                Ok(n) => output.emit(&buffer[..n]),
                Err(error) => break Some(format!("Connection lost: {error}")),
            },
            message = input.recv() => match message {
                Some(Input::Data(data)) => {
                    if echo {
                        output.echo(&data);
                    }
                    if let Err(error) = write.write_all(&data).await {
                        break Some(format!("Connection lost: {error}"));
                    }
                }
                Some(Input::Resize(..)) => {}
                Some(Input::Close) | None => {
                    let _ = write.shutdown().await;
                    break None;
                }
            },
        }
    };
    output.finish();
    reason
}

// ---------------------------------------------------------------- Telnet

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const OPT_BINARY: u8 = 0;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

#[derive(Clone, Copy)]
enum Parse {
    Data,
    Iac,
    Command(u8),
    Sub,
    SubIac,
}

/// Telnet option negotiation and stream decoding (pure: bytes in → data + replies out).
pub struct Telnet {
    state: Parse,
    /// Options we perform (answered WILL).
    local: [bool; 256],
    /// Options the server performs (answered DO).
    remote: [bool; 256],
    sub: Vec<u8>,
    last_cr: bool,
    pub cols: u16,
    pub rows: u16,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: Parse::Data,
            local: [false; 256],
            remote: [false; 256],
            sub: Vec::new(),
            last_cr: false,
            cols,
            rows,
        }
    }

    /// What we offer right away (like most clients): window size and terminal type, and ask the
    /// server to suppress go-ahead.
    pub fn greeting(&mut self) -> Vec<u8> {
        self.local[OPT_NAWS as usize] = true;
        self.local[OPT_TTYPE as usize] = true;
        vec![IAC, WILL, OPT_NAWS, IAC, WILL, OPT_TTYPE, IAC, DO, OPT_SGA]
    }

    pub fn server_echoes(&self) -> bool {
        self.remote[OPT_ECHO as usize]
    }

    /// Decode received bytes: returns (terminal data, replies to send).
    pub fn receive(&mut self, bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(bytes.len());
        let mut reply = Vec::new();
        for &byte in bytes {
            match self.state {
                Parse::Data => {
                    if byte == IAC {
                        self.state = Parse::Iac;
                    } else if self.last_cr && byte == 0 && !self.remote[OPT_BINARY as usize] {
                        // CR NUL = a bare carriage return.
                        self.last_cr = false;
                    } else {
                        self.last_cr = byte == b'\r';
                        data.push(byte);
                    }
                }
                Parse::Iac => {
                    self.state = Parse::Data;
                    match byte {
                        IAC => data.push(IAC),
                        DO | DONT | WILL | WONT => self.state = Parse::Command(byte),
                        SB => {
                            self.sub.clear();
                            self.state = Parse::Sub;
                        }
                        _ => {} // NOP, GA, AYT …
                    }
                }
                Parse::Command(command) => {
                    self.state = Parse::Data;
                    self.negotiate(command, byte, &mut reply);
                }
                Parse::Sub => {
                    if byte == IAC {
                        self.state = Parse::SubIac;
                    } else if self.sub.len() < 1024 {
                        self.sub.push(byte);
                    }
                }
                Parse::SubIac => {
                    if byte == SE {
                        self.state = Parse::Data;
                        self.subnegotiation(&mut reply);
                    } else {
                        self.sub.push(byte);
                        self.state = Parse::Sub;
                    }
                }
            }
        }
        (data, reply)
    }

    fn negotiate(&mut self, command: u8, option: u8, reply: &mut Vec<u8>) {
        let index = option as usize;
        match command {
            WILL => {
                let accept = matches!(option, OPT_ECHO | OPT_SGA | OPT_BINARY);
                if accept != self.remote[index] || !accept {
                    self.remote[index] = accept;
                    reply.extend_from_slice(&[IAC, if accept { DO } else { DONT }, option]);
                }
            }
            WONT => {
                if self.remote[index] {
                    self.remote[index] = false;
                    reply.extend_from_slice(&[IAC, DONT, option]);
                }
            }
            DO => {
                let accept = matches!(option, OPT_NAWS | OPT_TTYPE | OPT_SGA | OPT_BINARY);
                if accept != self.local[index] || !accept {
                    self.local[index] = accept;
                    reply.extend_from_slice(&[IAC, if accept { WILL } else { WONT }, option]);
                }
                if accept && option == OPT_NAWS {
                    reply.extend_from_slice(&self.window_size());
                }
            }
            DONT => {
                if self.local[index] {
                    self.local[index] = false;
                    reply.extend_from_slice(&[IAC, WONT, option]);
                }
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        // TTYPE SEND → TTYPE IS <name>
        if self.sub.first() == Some(&OPT_TTYPE) && self.sub.get(1) == Some(&1) {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, 0]);
            reply.extend_from_slice(TERM.to_ascii_uppercase().as_bytes());
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    /// NAWS report (only once the option is on).
    pub fn window_size(&self) -> Vec<u8> {
        if !self.local[OPT_NAWS as usize] {
            return Vec::new();
        }
        let mut out = vec![IAC, SB, OPT_NAWS];
        for byte in self
            .cols
            .to_be_bytes()
            .into_iter()
            .chain(self.rows.to_be_bytes())
        {
            out.push(byte);
            if byte == IAC {
                out.push(IAC);
            }
        }
        out.extend_from_slice(&[IAC, SE]);
        out
    }

    /// Escape typed input: IAC doubled; a bare CR is sent as CR NUL outside binary mode.
    pub fn encode(&self, data: &[u8]) -> Vec<u8> {
        let binary = self.local[OPT_BINARY as usize];
        let mut out = Vec::with_capacity(data.len() + 4);
        for (index, &byte) in data.iter().enumerate() {
            out.push(byte);
            if byte == IAC {
                out.push(IAC);
            } else if byte == b'\r' && !binary && data.get(index + 1) != Some(&b'\n') {
                out.push(0);
            }
        }
        out
    }
}

async fn run_telnet(
    socket: tokio::net::TcpStream,
    mut output: Output,
    mut input: mpsc::UnboundedReceiver<Input>,
    cols: u16,
    rows: u16,
    echo: bool,
) -> Option<String> {
    let (mut read, mut write) = socket.into_split();
    let mut telnet = Telnet::new(cols, rows);
    if let Err(error) = write.write_all(&telnet.greeting()).await {
        return Some(format!("Connection lost: {error}"));
    }
    let mut buffer = vec![0_u8; 16 * 1024];
    let reason = loop {
        tokio::select! {
            result = read.read(&mut buffer) => match result {
                Ok(0) => break Some("Connection closed by peer".to_owned()),
                Ok(n) => {
                    let (data, reply) = telnet.receive(&buffer[..n]);
                    output.emit(&data);
                    if !reply.is_empty() {
                        if let Err(error) = write.write_all(&reply).await {
                            break Some(format!("Connection lost: {error}"));
                        }
                    }
                }
                Err(error) => break Some(format!("Connection lost: {error}")),
            },
            message = input.recv() => {
                let bytes = match message {
                    Some(Input::Data(data)) => {
                        // Local echo only while the server does not echo.
                        if echo && !telnet.server_echoes() {
                            output.echo(&data);
                        }
                        telnet.encode(&data)
                    }
                    Some(Input::Resize(cols, rows)) => {
                        telnet.cols = cols;
                        telnet.rows = rows;
                        telnet.window_size()
                    }
                    Some(Input::Close) | None => {
                        let _ = write.shutdown().await;
                        break None;
                    }
                };
                if !bytes.is_empty() {
                    if let Err(error) = write.write_all(&bytes).await {
                        break Some(format!("Connection lost: {error}"));
                    }
                }
            },
        }
    };
    output.finish();
    reason
}

// ---------------------------------------------------------------- Serial

fn start_serial(
    spec: &ConnectionSpec,
    mut output: Output,
    mut input: mpsc::UnboundedReceiver<Input>,
    on_exit: OnExit,
) -> Result<(), String> {
    use serialport::{DataBits, FlowControl, Parity, StopBits};
    let serial = &spec.serial;
    let device = serial.device.trim();
    if device.is_empty() {
        return Err("Serial session has no port".into());
    }
    let data_bits = match serial.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let parity = match serial.parity.as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let stop_bits = if serial.stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    };
    let flow = match serial.flow_control.as_str() {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    };
    let baud = if serial.baud_rate == 0 {
        115_200
    } else {
        serial.baud_rate
    };
    log::info!(
        "Serial open {device} {baud} {:?} {:?} {:?} {:?}",
        data_bits,
        parity,
        stop_bits,
        flow
    );
    let mut reader = serialport::new(device, baud)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|error| format!("Cannot open {device}: {error}"))?;
    let mut writer = reader
        .try_clone()
        .map_err(|error| format!("Cannot open {device}: {error}"))?;
    let closed = Arc::new(AtomicBool::new(false));
    let echo = spec.local_echo;

    // Writer: input channel → port (blocking).
    let closing = closed.clone();
    let echo_output = Output {
        shared: output.shared.clone(),
        session_id: output.session_id.clone(),
        decoder: Utf8Stream::default(),
    };
    std::thread::Builder::new()
        .name("serial-write".into())
        .spawn(move || {
            while let Some(message) = input.blocking_recv() {
                match message {
                    Input::Data(data) => {
                        if echo {
                            echo_output.echo(&data);
                        }
                        if writer
                            .write_all(&data)
                            .and_then(|_| writer.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                    Input::Resize(..) => {}
                    Input::Close => break,
                }
            }
            closing.store(true, Ordering::SeqCst);
        })
        .map_err(|error| format!("Cannot start serial writer: {error}"))?;

    // Reader: port → terminal until closed or the device goes away.
    let device = device.to_owned();
    std::thread::Builder::new()
        .name("serial-read".into())
        .spawn(move || {
            let mut buffer = [0_u8; 4096];
            let reason = loop {
                if closed.load(Ordering::SeqCst) {
                    break None;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => {}
                    Ok(n) => output.emit(&buffer[..n]),
                    Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => break Some(format!("{device}: {error}")),
                }
            };
            output.finish();
            on_exit(reason);
        })
        .map_err(|error| format!("Cannot start serial reader: {error}"))?;
    Ok(())
}

/// Serial ports present on this machine (`system.serialPorts`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SerialPortInfo {
    pub path: String,
    /// USB product / manufacturer when known.
    pub description: String,
}

pub fn serial_ports() -> Vec<SerialPortInfo> {
    let mut ports: Vec<SerialPortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|port| {
            let description = match port.port_type {
                serialport::SerialPortType::UsbPort(usb) => [usb.product, usb.manufacturer]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::Unknown => String::new(),
            };
            SerialPortInfo {
                path: port.port_name,
                description,
            }
        })
        .collect();
    ports.sort_by(|a, b| a.path.cmp(&b.path));
    ports.dedup_by(|a, b| a.path == b.path);
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_negotiation() {
        let mut telnet = Telnet::new(80, 24);
        let _ = telnet.greeting();
        // Server: WILL ECHO, DO NAWS, DO TTYPE, SB TTYPE SEND, DO LINEMODE (34), then data "hi".
        let input = [
            IAC, WILL, OPT_ECHO, IAC, DO, OPT_NAWS, IAC, SB, OPT_TTYPE, 1, IAC, SE, IAC, DO, 34,
            b'h', b'i', IAC, IAC,
        ];
        let (data, reply) = telnet.receive(&input);
        assert_eq!(data, b"hi\xff");
        assert!(telnet.server_echoes());
        // DO ECHO; NAWS already WILL → only the size report; TTYPE IS; WONT LINEMODE.
        let mut expected = vec![IAC, DO, OPT_ECHO, IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE];
        expected.extend_from_slice(&[IAC, SB, OPT_TTYPE, 0]);
        expected.extend_from_slice(b"XTERM-256COLOR");
        expected.extend_from_slice(&[IAC, SE, IAC, WONT, 34]);
        assert_eq!(reply, expected);
        // Repeated WILL ECHO: no reply (no negotiation loop).
        assert!(telnet.receive(&[IAC, WILL, OPT_ECHO]).1.is_empty());
        // Split across reads.
        assert_eq!(telnet.receive(&[b'a', IAC]).0, b"a");
        assert_eq!(telnet.receive(&[IAC, b'b']).0, b"\xffb");
        // CR NUL → CR
        assert_eq!(telnet.receive(b"x\r\0y").0, b"x\ry");
    }

    #[test]
    fn telnet_encode() {
        let telnet = Telnet::new(80, 24);
        assert_eq!(telnet.encode(b"ls\r"), b"ls\r\0");
        assert_eq!(telnet.encode(b"a\r\nb"), b"a\r\nb");
        assert_eq!(telnet.encode(&[IAC]), vec![IAC, IAC]);
    }

    #[test]
    fn naws_escapes_255() {
        let mut telnet = Telnet::new(255, 24);
        let _ = telnet.greeting();
        assert_eq!(
            telnet.window_size(),
            vec![IAC, SB, OPT_NAWS, 0, 255, 255, 0, 24, IAC, SE]
        );
    }
}
