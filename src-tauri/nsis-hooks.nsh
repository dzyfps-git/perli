; Folders must not go on opening in a Perli that is gone. An update keeps the setting, because
; the program stays where it is.
; The journal helper in Program Files goes too, with Windows asking for admin, if it was set up.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-default'
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --journal-off'
  ${EndIf}
!macroend
