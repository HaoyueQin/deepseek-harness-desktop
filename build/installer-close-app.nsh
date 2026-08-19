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

; ---------------------------------------------------------------------------
; 安装目录缩短：默认安装目录从 "DeepSeek Harness Desktop"（21 字符）改为 "dsh"（3 字符）
; —— 为路径长度腾出 ~18 字符余量（Windows MAX_PATH 260 限制，配合构建期清理/嵌套
; 去重，把最深路径从 269 压到 250 以下，让 NSIS 3.0.4.1 卸载器的 Rename 不再失败）。
;
; 时机：customInit 在模板 initMultiUser（multiUser.nsh 里设 $INSTDIR 为
; "$LocalAppData\Programs\${APP_FILENAME}"）之后、目录选择页之前执行。
; 判断"用户已通过 /D 指定目录"或"已安装"时不改，保持升级/自定义路径兼容。
!macro customInit
  ${if} $INSTDIR != ""
  ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ; 已安装（升级）：保持原安装目录，不迁移
  ${else}
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R0 == ""
      StrCpy $INSTDIR "$LocalAppData\Programs\dsh"
    ${endIf}
  ${endIf}
!macroend

; ---------------------------------------------------------------------------
; 长路径卸载兜底
;
; 背景：NSIS 3.0.4.1（electron-builder 26 内置）的删除路径受 MAX_PATH 260
; 限制——卸载器默认用 un.atomicRMDir 逐文件 Rename，超长路径必然失败导致
; 更新/卸载卡死。构建期 trimDshTree 已把路径压到 250 字符以内，但将来新依赖
; 可能再引入超长路径，这里做最后防线：
; 用 PowerShell Remove-Item（.NET 4.6.2+ 原生支持长路径）删除整个安装目录，
; 完全绕过 NSIS 的 Rename/RMDir 限制。失败时保留 NSIS 原生 RMDir /r 兜底。
;
; 时序：customRemoveFiles 被卸载器 uninstaller.nsh 引用时，完全替代其默认
; 删除逻辑（isUpdated 分支的 un.atomicRMDir + RMDir /r）——见
; app-builder-lib/templates/nsis/uninstaller.nsh 第 161 行 !ifmacrodef customRemoveFiles。
!macro customRemoveFiles
  DetailPrint "删除安装目录（长路径安全）: $INSTDIR"
  ; $INSTDIR 可能含单引号（用户自定义路径），PowerShell 单引号字符串内
  ; 用两个单引号转义。纯 NSIS 指令遍历替换（不依赖 TextFunc/LogicLib——
  ; 卸载器链未 include 这些库），结果存入 $R1。
  StrCpy $R1 ""
  StrCpy $R4 "$INSTDIR"
  StrLen $R5 $R4
  StrCpy $R8 0
  dsh_rm_loop:
    IntCmp $R8 $R5 dsh_rm_done
    StrCpy $R7 $R4 1 $R8
    StrCmp $R7 "'" dsh_rm_quote
    StrCpy $R1 "$R1$R7"
    IntOp $R8 $R8 + 1
    Goto dsh_rm_loop
  dsh_rm_quote:
    StrCpy $R1 "$R1''"
    IntOp $R8 $R8 + 1
    Goto dsh_rm_loop
  dsh_rm_done:
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /C powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath '$R1' -Recurse -Force -ErrorAction SilentlyContinue"`
  Pop $R0
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "长路径删除失败，回退 NSIS 原生删除"
    RMDir /r $INSTDIR
  ${endIf}
!macroend
