; Folders must not go on opening in a Perli that is gone. An update keeps the setting, because
; the program stays where it is.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-default'
  ${EndIf}
!macroend
