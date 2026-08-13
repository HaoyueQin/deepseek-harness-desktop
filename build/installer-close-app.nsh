; 安装/更新时自动关闭运行中的应用，替代 electron-builder 默认的
; "请手动关闭" 流程。应用设计为托盘常驻（关闭窗口 ≠ 退出），默认温和杀
; 无效、强杀两次失败会弹 "无法关闭" 卡死安装。
;
; /F 强杀 + /T 杀进程树（连 dsh node 子进程一起）。taskkill /IM 按映像名
; 精确匹配，安装器是 Setup.exe 不会命中，无需 $pid 过滤器（该变量在自定义
; 宏分支未定义，用了会 warning treated as error）。
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 500
!macroend
