; Custom NSIS hooks for Aura Farming installer
;
; Finish page: "Launch Aura Farming" checkbox
; ────────────────────────────────────────────
; electron-builder exposes runAfterFinish:true but relies on the $launchLink
; variable (a start-menu .lnk path) which can be empty or stale on first
; install.  Defining customFinishPage here gives us full control: we launch
; the exe directly from $INSTDIR so the checkbox always works.
;
; The Function must be at file scope (outside any macro) so MUI2 can resolve
; it as a valid callback.  The !ifndef BUILD_UNINSTALLER guard keeps it out
; of the uninstaller binary where it is not needed.
;
!ifndef BUILD_UNINSTALLER
  ; Launch the app directly from $INSTDIR — avoids relying on $launchLink,
  ; which is a start-menu .lnk path that may not exist on first install.
  ; ExecShell is a built-in NSIS command (no plugin required) that goes
  ; through ShellExecuteEx, which handles the UAC de-elevation correctly
  ; in most Windows sessions without requiring the StdUtils plugin.
  Function LaunchAuraFarming
    ExecShell "" "$INSTDIR\Aura Farming.exe"
  FunctionEnd

  !macro customFinishPage
    !define MUI_FINISHPAGE_RUN_TEXT "Launch Aura Farming"
    !define MUI_FINISHPAGE_RUN_FUNCTION "LaunchAuraFarming"
    !define MUI_FINISHPAGE_RUN
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif

; Desktop shortcut strategy
; ─────────────────────────
; CreateShortcut overwrites the .lnk file in-place on every install.
; Windows stores desktop icon positions by file-name in the registry
; (HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop), so the user's
; saved position is preserved across updates even when the file content
; changes.
;
; We use a TARGETED SHChangeNotify (SHCNE_UPDATEITEM, SHCNF_PATH) for
; the specific .lnk file.  The previous approach used the broad
; SHCNE_ASSOCCHANGED (0x8000000) flag which tells Explorer that ALL file
; associations have changed — that was the root cause of icons "jumping
; around" on update (Explorer re-sorted the entire Desktop in response).
;
; customInit (new installer) → writes registry flag
; OLD version's customUnInstall reads the flag → skips deleting shortcut
;   (so position is never lost; the new customInstall will overwrite it)
; customInstall (new installer) → overwrites shortcut with fresh paths,
;   clears the flag.

!macro customInit
  ; electron-builder 25 does not support a defaultDirName configuration
  ; property. Set the initial directory through NSIS so the directory page
  ; opens at Program Files while still allowing the user to change it.
  StrCpy $INSTDIR "$PROGRAMFILES\Aura Farming"
  ; Aura Farming stays alive in the system tray after its window is closed.
  ; Stop that tray process before NSIS checks files for replacement; otherwise
  ; users can see "Aura Farming cannot be closed" even when no window is open.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "Aura Farming.exe"' $R9
  Sleep 1000
  ; Signal to any already-installed version's uninstaller that this is an
  ; update, not a user-initiated uninstall.  The old customUnInstall reads
  ; this flag and skips deleting the desktop shortcut so the icon position
  ; is not lost (the new installer's customInstall will overwrite it in-place).
  WriteRegStr HKCU "Software\AuraFarming" "UpdatingNow" "1"
!macroend

!macro customInstall
  ; Always create (or overwrite) the desktop shortcut.
  ;
  ; On first install: creates fresh .lnk pointing to $INSTDIR.
  ; On update (same or different directory): overwrites existing .lnk with
  ; the current $INSTDIR so the target exe path and embedded icon are always
  ; correct.  Because the file-name is unchanged, Windows keeps the saved
  ; desktop icon position.
  ;
  ; Root cause of the "blank white desktop icon" bug: the previous approach
  ; used IfFileExists to SKIP CreateShortcut when a .lnk already existed.
  ; On a reinstall to a different directory the preserved shortcut still
  ; pointed to the old (now-deleted) exe path — Windows could not load the
  ; icon from that missing exe and rendered a blank white placeholder.
  ;
  ; Use the exe's embedded icon (4th arg = icon file, 5th = index 0) so
  ; the icon is always available as long as the exe is installed, with no
  ; dependency on a separately shipped .ico file.
  CreateShortcut "$DESKTOP\Aura Farming.lnk" "$INSTDIR\Aura Farming.exe" "" "$INSTDIR\Aura Farming.exe" 0

  ; Targeted icon-cache refresh: SHCNE_UPDATEITEM (0x2000) + SHCNF_PATH|SHCNF_FLUSH (0x0005)
  ; tells Explorer to reload the icon for this specific file only, without
  ; triggering a full Desktop re-sort.
  System::Call 'Shell32::SHChangeNotify(l 0x00002000, l 0x00000005, w "$DESKTOP\Aura Farming.lnk", i 0)'

  ; Clear the update-in-progress flag now that install is complete.
  DeleteRegValue HKCU "Software\AuraFarming" "UpdatingNow"
!macroend

!macro customUnInstall
  ; If the new installer wrote the "UpdatingNow" flag we are being called as
  ; part of an update — leave the desktop shortcut alone.  The new installer's
  ; customInstall will overwrite it in-place with the correct new target path.
  ; Only delete it on a real user-initiated uninstall (no flag).
  ReadRegStr $R0 HKCU "Software\AuraFarming" "UpdatingNow"
  StrCmp $R0 "1" uninstall_skip_shortcut uninstall_delete_shortcut
  uninstall_delete_shortcut:
    Delete "$DESKTOP\Aura Farming.lnk"
  uninstall_skip_shortcut:
!macroend
