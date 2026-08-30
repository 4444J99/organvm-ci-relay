$ErrorActionPreference = 'Stop'

@'
@echo off
set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if not defined VSPATH exit /b 1
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %ERRORLEVEL%
cl /nologo /W4 /WX /std:c17 windows-lpenvironment-enactment.c
if errorlevel 1 exit /b %ERRORLEVEL%
windows-lpenvironment-enactment.exe > windows-output.txt
set "HARNESS_EXIT=%ERRORLEVEL%"
type windows-output.txt
if not "%HARNESS_EXIT%"=="0" exit /b %HARNESS_EXIT%
'@ | Set-Content -LiteralPath relay-build-and-run.cmd -Encoding ascii

& cmd.exe /d /c relay-build-and-run.cmd
if ($LASTEXITCODE -ne 0) {
  throw "Windows build or harness exited $LASTEXITCODE"
}

$lines = @(Get-Content -LiteralPath windows-output.txt)
if ($lines.Count -ne 18) {
  throw "Expected 18 observation lines; found $($lines.Count)"
}
$expected = [ordered]@{
  'CASE:inherit-null-lpEnvironment' = 1
  'CASE:custom-base-block' = 1
  'CASE:custom-append-block' = 1
  'CASE:custom-omit-block' = 1
  'CASE:custom-replace-block' = 1
  'PM_INHERITED=parent' = 1
  'PM_FIRST=1' = 2
  'PM_SECOND=2' = 4
  'PM_THIRD=3' = 4
  'PM_ADDED=entry' = 1
  'PM_FIRST=replaced' = 1
}
foreach ($entry in $expected.GetEnumerator()) {
  $actual = @($lines | Where-Object { $_ -ceq $entry.Key }).Count
  if ($actual -ne $entry.Value) {
    throw "Expected '$($entry.Key)' $($entry.Value) time(s); found $actual"
  }
}
