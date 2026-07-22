; Custom NSIS hooks for Aura Farming installer
;
; Desktop shortcut: created on first install only.
; On every subsequent update the existing .lnk is left untouched so
; Windows never loses the saved icon position and desktop layout is preserved.
;
; Strategy: customInit (runs at the very start of the new installer, BEFORE
; the old uninstaller is called during an update) writes a registry flag so
; the OLD version's customUnInstall knows it is being called as part of an
; update and must not delete the shortcut.  customInstall clears the flag
; when done.  On a real user-initiated uninstall no new installer runs first,
; so the flag is absent and customUnInstall cleans up normally.

!macro customInit
  ; Signal to any already-installed version's uninstaller that this is an
  ; update, not a user-initiated uninstall.  The old customUnInstall reads
  ; this flag and skips deleting the desktop shortcut so the icon position
  ; (and the rest of the desktop layout) is preserved.
  WriteRegStr HKCU "Software\AuraFarming" "UpdatingNow" "1"
!macroend

!macro customInstall
  ; Only create the desktop shortcut if one doesn't already exist.
  ; This preserves the user's desktop icon position across updates.
  IfFileExists "$DESKTOP\Aura Farming.lnk" desktop_shortcut_done desktop_shortcut_create
  desktop_shortcut_create:
    CreateShortcut "$DESKTOP\Aura Farming.lnk" "$INSTDIR\Aura Farming.exe" "" "$INSTDIR\resources\icon.ico" 0
  desktop_shortcut_done:
  ; Clear the update-in-progress flag now that install is complete.
  DeleteRegValue HKCU "Software\AuraFarming" "UpdatingNow"
!macroend

!macro customUnInstall
  ; If the new installer wrote the "UpdatingNow" flag we are being called as
  ; part of an update — leave the desktop shortcut alone so the icon position
  ; is not lost.  Only delete it on a real user-initiated uninstall (no flag).
  ReadRegStr $R0 HKCU "Software\AuraFarming" "UpdatingNow"
  StrCmp $R0 "1" uninstall_skip_shortcut uninstall_delete_shortcut
  uninstall_delete_shortcut:
    Delete "$DESKTOP\Aura Farming.lnk"
  uninstall_skip_shortcut:
!macroend
