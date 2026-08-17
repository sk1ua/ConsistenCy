!macro customInstall
  FileOpen $0 "$INSTDIR\\.consistency-nsis-installed" w
  FileWrite $0 "nsis$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\\.consistency-nsis-installed"
!macroend
