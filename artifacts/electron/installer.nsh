; Custom NSIS hooks for Aura Farming installer
;
; Desktop shortcut: created on first install only.
; On every subsequent update the existing .lnk is left untouched so
; Windows never loses the saved icon position and desktop layout is preserved.

!macro customInstall
  ; Only create the desktop shortcut if one doesn't already exist.
  ; This preserves the user's desktop icon position across updates.
  IfFileExists "$DESKTOP\Aura Farming.lnk" desktop_shortcut_done desktop_shortcut_create
  desktop_shortcut_create:
    CreateShortcut "$DESKTOP\Aura Farming.lnk" "$INSTDIR\Aura Farming.exe" \
      "" "$INSTDIR\Aura Farming.exe" 0
  desktop_shortcut_done:
!macroend

!macro customUnInstall
  ; Remove the desktop shortcut when the user uninstalls.
  Delete "$DESKTOP\Aura Farming.lnk"
!macroend
