; PanUrgos Studio — Windows installer
; Bootstrapper: unpacks to a temp folder and launches the PanUrgos Setup wizard (Electron UI, src/main/installer).
; Built by build/build-installer.js:  makensis -DVERSION=x.y.z -DLLAMA_TAG=bNNNN installer.nsi

Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!ifndef LLAMA_TAG
  !define LLAMA_TAG "bundled"
!endif
!define APPNAME   "PanUrgos Studio"
!define EXE       "PanUrgos Studio.exe"
!define PUBLISHER "PanUrgos"
!define PROGID    "PanUrgosStudio.Code"
!define UNINST    "Software\Microsoft\Windows\CurrentVersion\Uninstall\PanUrgosStudio"
!define CAPS      "Software\PanUrgos Studio\Capabilities"
!define SRC       "..\dist\win-unpacked"

Name "${APPNAME}"
Caption "PanUrgos Studio Setup"
OutFile "..\dist\PanUrgos-Studio-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\PanUrgos Studio"
InstallDirRegKey HKCU "${UNINST}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText " "
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "PanUrgos Studio Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

; ---------------------------------------------------------------- look & feel (PanUrgos dark theme)
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_BGCOLOR "0A0B10"
!define MUI_TEXTCOLOR "E6E9F2"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "installer-header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "installer-header.bmp"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_INSTFILESPAGE_COLORS "C8CFDF 05060A"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_GUIINIT ThemeWindow
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.ThemeWindow

!define MUI_PAGE_HEADER_TEXT "Preparing PanUrgos Studio Setup"
!define MUI_PAGE_HEADER_SUBTEXT "Nothing is installed until you choose to."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ThemeInstPage
!insertmacro MUI_PAGE_INSTFILES

!define MUI_PAGE_HEADER_TEXT "Uninstall PanUrgos Studio"
!define MUI_PAGE_HEADER_SUBTEXT "Your projects are never touched."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ThemeInstPage
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ThemeInstPage
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------- progress lines (Claude-Code-style checklist)
!macro STATUS TEXT
  SetDetailsPrint textonly
  DetailPrint "${TEXT}"
  SetDetailsPrint none
!macroend
!macro DONE TEXT
  SetDetailsPrint listonly
  DetailPrint "✓  ${TEXT}"
  SetDetailsPrint none
!macroend

; ---------------------------------------------------------------- theming helpers
!macro DARKEN_PAGE
  ; Outer window + inner page backgrounds, header text, progress bar.
  SetCtlColors $HWNDPARENT E6E9F2 0A0B10
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 E6E9F2 0A0B10
  GetDlgItem $1 $0 1006         ; status text
  SetCtlColors $1 A3ABC0 0A0B10
  GetDlgItem $1 $0 1004         ; progress bar → flat PanUrgos violet
  System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
  SendMessage $1 0x0409 0 0xF65C8B   ; PBM_SETBARCOLOR  #8B5CF6 (BGR)
  SendMessage $1 0x2001 0 0x231815   ; PBM_SETBKCOLOR   #151823
  GetDlgItem $1 $HWNDPARENT 1037 ; header title
  SetCtlColors $1 E6E9F2 transparent
  GetDlgItem $1 $HWNDPARENT 1038 ; header subtitle
  SetCtlColors $1 A3ABC0 transparent
  GetDlgItem $1 $0 1027         ; "Show details"
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1035 ; separator line
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1028 ; branding text
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1256 ; branding text shadow
  ShowWindow $1 ${SW_HIDE}
!macroend

Function ThemeWindow
  SetCtlColors $HWNDPARENT E6E9F2 0A0B10
FunctionEnd
Function un.ThemeWindow
  SetCtlColors $HWNDPARENT E6E9F2 0A0B10
FunctionEnd

Function ThemeInstPage
  !insertmacro DARKEN_PAGE
  ; One-click: no Back/Next during install (Cancel stays for safety).
  GetDlgItem $1 $HWNDPARENT 1
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 3
  ShowWindow $1 ${SW_HIDE}
FunctionEnd
Function un.ThemeInstPage
  !insertmacro DARKEN_PAGE
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1006
  SetCtlColors $1 E6E9F2 0A0B10
  GetDlgItem $1 $0 1000         ; uninstall-from path box
  SetCtlColors $1 C8CFDF 151823
FunctionEnd

; ---------------------------------------------------------------- file associations
!macro ASSOC EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\SupportedTypes" ".${EXT}" ""
  WriteRegStr HKCU "${CAPS}\FileAssociations" ".${EXT}" "${PROGID}"
!macroend
; Uninstall removes ONLY PanUrgos's own value. The .ext and OpenWithProgids keys are shared with other
; apps (VS Code, etc.): never delete them. (DeleteRegKey /ifempty ignores values, so it would wipe
; other editors' “Open with” entries.)
!macro UNASSOC EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend
!macro FOR_EACH_EXT M
  !insertmacro ${M} "js"
  !insertmacro ${M} "mjs"
  !insertmacro ${M} "cjs"
  !insertmacro ${M} "jsx"
  !insertmacro ${M} "ts"
  !insertmacro ${M} "tsx"
  !insertmacro ${M} "json"
  !insertmacro ${M} "jsonc"
  !insertmacro ${M} "md"
  !insertmacro ${M} "markdown"
  !insertmacro ${M} "txt"
  !insertmacro ${M} "log"
  !insertmacro ${M} "html"
  !insertmacro ${M} "htm"
  !insertmacro ${M} "css"
  !insertmacro ${M} "scss"
  !insertmacro ${M} "less"
  !insertmacro ${M} "py"
  !insertmacro ${M} "pyw"
  !insertmacro ${M} "c"
  !insertmacro ${M} "h"
  !insertmacro ${M} "cpp"
  !insertmacro ${M} "cc"
  !insertmacro ${M} "hpp"
  !insertmacro ${M} "cs"
  !insertmacro ${M} "fs"
  !insertmacro ${M} "java"
  !insertmacro ${M} "kt"
  !insertmacro ${M} "kts"
  !insertmacro ${M} "go"
  !insertmacro ${M} "rs"
  !insertmacro ${M} "rb"
  !insertmacro ${M} "php"
  !insertmacro ${M} "swift"
  !insertmacro ${M} "lua"
  !insertmacro ${M} "sql"
  !insertmacro ${M} "sh"
  !insertmacro ${M} "bash"
  !insertmacro ${M} "ps1"
  !insertmacro ${M} "psm1"
  !insertmacro ${M} "bat"
  !insertmacro ${M} "cmd"
  !insertmacro ${M} "yml"
  !insertmacro ${M} "yaml"
  !insertmacro ${M} "toml"
  !insertmacro ${M} "ini"
  !insertmacro ${M} "cfg"
  !insertmacro ${M} "conf"
  !insertmacro ${M} "xml"
  !insertmacro ${M} "svg"
  !insertmacro ${M} "vue"
  !insertmacro ${M} "svelte"
  !insertmacro ${M} "dart"
  !insertmacro ${M} "r"
  !insertmacro ${M} "gradle"
  !insertmacro ${M} "properties"
  !insertmacro ${M} "env"
!macroend

; ---------------------------------------------------------------- helpers

Function un.CloseRunning
  retry:
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${EXE}" /NH | find /I "${EXE}"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "PanUrgos Studio is running.$\r$\n$\r$\nClose it, then click Retry." /SD IDCANCEL IDRETRY retry
      Abort "PanUrgos Studio is still running."
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- bootstrap
; Setup.exe only unpacks itself, then hands over to the PanUrgos Setup wizard (license, system check,
; location, components, install). Nothing is installed until the user clicks Install in the wizard.
; The temporary folder ($PLUGINSDIR) is deleted automatically when this process exits.
Section "Bootstrap" SecMain
  !insertmacro STATUS "Unpacking setup files…"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${SRC}\*.*"
  SetOutPath "$PLUGINSDIR\payload\redist"
  File "redist\vc_redist.x64.exe"
  ; The uninstaller travels with the payload; the wizard copies it into the install folder.
  WriteUninstaller "$PLUGINSDIR\payload\Uninstall PanUrgos Studio.exe"
  !insertmacro STATUS "Starting PanUrgos Studio Setup…"
  HideWindow
  ExecWait '"$PLUGINSDIR\payload\${EXE}" --installer' $0
  ; Let Chromium's helper processes exit so the temp folder can be removed.
  Sleep 1200
  SetOutPath "$TEMP"
SectionEnd

; ---------------------------------------------------------------- uninstall
Section "Uninstall"
  SetDetailsPrint textonly
  DetailPrint "Removing PanUrgos Studio…"
  SetDetailsPrint none
  Call un.CloseRunning

  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\bin\path.ps1" -Mode remove -Dir "$INSTDIR\bin"'
  Pop $0
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=3000

  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"

  !insertmacro FOR_EACH_EXT UNASSOC
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${EXE}"
  DeleteRegKey HKCU "Software\Classes\*\shell\PanUrgosStudio"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PanUrgosStudio"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PanUrgosStudio"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${APPNAME}"
  DeleteRegKey HKCU "Software\PanUrgos Studio"
  DeleteRegKey HKCU "${UNINST}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  RMDir /r "$INSTDIR"

  ; Settings, encrypted keys, llama.cpp downloads and models live in %APPDATA%\PanUrgos Studio.
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your PanUrgos settings, stored API keys, downloaded llama.cpp builds and models?$\r$\n$\r$\n$APPDATA\PanUrgos Studio$\r$\n$\r$\nChoose No to keep them for a future install." IDNO keep
    RMDir /r "$APPDATA\PanUrgos Studio"
    keep:
  ${EndIf}
SectionEnd
