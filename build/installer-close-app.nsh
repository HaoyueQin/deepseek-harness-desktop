; 安装/更新时自动关闭运行中的应用，替代 electron-builder 默认的
; "请手动关闭" 流程。应用设计为托盘常驻（关闭窗口 ≠ 退出），默认温和杀
; 无效、强杀两次失败会弹 "无法关闭" 卡死安装。
;
; /F 强杀 + /T 杀进程树（连 dsh node 子进程一起）。taskkill /IM 按映像名
; 精确匹配，安装器是 Setup.exe 不会命中，无需 $pid 过滤器（该变量在自定义
; 宏分支未定义，用了会 warning treated as error）。
;
; 循环验证：taskkill 后轮询 tasklist 直到进程消失（最多 ~6s）。原实现只
; taskkill 一次不验证结果，进程仍在时进入卸载/解压阶段会撞文件锁，弹
; "无法关闭" 卡死安装。tasklist 返回 0 = 进程仍在，非 0 = 已消失。
!macro customCheckAppRunning
  StrCpy $R9 0
  ${Do}
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0 ; 丢弃 taskkill 返回码，避免栈残留
    Sleep 500
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0 ; 0 = 进程仍在
    ${if} $R0 != 0
      ${ExitDo} ; 进程已消失
    ${endIf}
    IntOp $R9 $R9 + 1
    ${if} $R9 >= 12
      ${ExitDo} ; 12 次仍杀不掉（如管理员权限进程）：放弃，后续阶段由模板兜底弹窗
    ${endIf}
  ${Loop}
!macroend
