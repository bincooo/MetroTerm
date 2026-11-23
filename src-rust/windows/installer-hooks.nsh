; MetroTerm: additions to Tauri's NSIS installer (tauri.conf.json → bundle.windows.nsis.installerHooks).
; Included near the top of Tauri's installer.nsi, after MUI2 / FileFunc / LogicLib.
;
; Choose-folder page: a folder the installer cannot write to (C:\Program Files when installing for
; the current user only, a protected folder on another drive …) used to fail half-way through the
; installation with "Error opening file for writing". .onVerifyInstDir now tries to create a folder
; in the nearest existing parent of the chosen path; when that fails, Next stays disabled and the
; page says why and what to do. Spaces and non-ASCII names (中文) are fine — the installer is
; Unicode; only the permission matters.

!include LogicLib.nsh

; The page's own description text, put back once the folder is fine again.
Var MetroTermDirTop

Function .onVerifyInstDir
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $3 1 ; 1 = can be written

  ; Nearest folder of $INSTDIR that already exists.
  StrCpy $0 $INSTDIR
  ${Do}
    ${If} ${FileExists} "$0\*.*"
      ${ExitDo}
    ${EndIf}
    ${GetParent} $0 $1
    ${If} $1 == ""
    ${OrIf} $1 == $0
      StrCpy $0 "" ; no such drive: NSIS's own path check decides
      ${ExitDo}
    ${EndIf}
    StrCpy $0 $1
  ${Loop}

  ; Creating a folder there is the first thing the installation does.
  ${If} $0 != ""
    StrCpy $1 "$0\metroterm-setup-check.tmp"
    ${IfNot} ${FileExists} "$1\*.*"
      ClearErrors
      CreateDirectory $1
      ${If} ${Errors}
        StrCpy $3 0
      ${Else}
        RMDir $1
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; Only on the choose-folder page (it has the folder box, control 1019); 1006 is its description.
  FindWindow $1 "#32770" "" $HWNDPARENT
  GetDlgItem $2 $1 1019
  ${If} $2 <> 0
    GetDlgItem $1 $1 1006
    ${If} $MetroTermDirTop == ""
      System::Call 'user32::GetWindowText(p r1, t .r2, i ${NSIS_MAX_STRLEN})'
      StrCpy $MetroTermDirTop $2
    ${EndIf}
    ${If} $3 = 0
      ${If} $LANGUAGE = 2052
        StrCpy $2 "无法在这个位置创建文件夹：没有写入权限（需要管理员权限）。请换一个文件夹，或者返回上一步选择为所有用户安装。"
      ${Else}
        StrCpy $2 "Setup cannot create a folder in this location: no write permission (administrator rights are needed). Choose another folder, or go back and install for all users."
      ${EndIf}
      SendMessage $1 ${WM_SETTEXT} 0 "STR:$2"
    ${Else}
      SendMessage $1 ${WM_SETTEXT} 0 "STR:$MetroTermDirTop"
    ${EndIf}
  ${EndIf}

  ${If} $3 = 0
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    Abort ; disables Next
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
