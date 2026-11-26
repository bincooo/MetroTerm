# Agent detection manifests

These TOML files are the bundled agent detection manifests, one per agent CLI (Apache License 2.0,
like MetroTerm; see "参考项目" at the end of the project README).

They are compiled into the backend (`agents/mod.rs`, `include_str!`) and evaluated by
`agents/manifest.rs`. A file of the same name in `~/.metroterm/agents/` replaces the bundled one.

The rules read only the terminal output: the visible screen text, the window title (OSC 0/2) and
the progress report (OSC 9). No plugins or hooks that report state over a socket are part of
MetroTerm.
