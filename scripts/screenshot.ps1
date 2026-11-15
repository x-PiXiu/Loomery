param(
  [string]$Title = "Loomery",
  [string]$Out = "shot.png",
  [switch]$Close
)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LoomWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [IntPtr]::Zero
$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($proc) { $h = $proc.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { $h = [LoomWin]::FindWindow($null, $Title) }
if ($h -eq [IntPtr]::Zero) { Write-Error "window '$Title' not found"; exit 1 }
if ($Close) {
  [LoomWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Output "close requested"
  exit 0
}
[LoomWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$r = New-Object LoomWin+RECT
[LoomWin]::GetWindowRect($h, [ref]$r) | Out-Null
Add-Type -AssemblyName System.Drawing
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (0x2)：直接读取窗口自身内容，Chromium/Electron 硬件加速窗口也能抓到，且不受遮挡影响
$ok = [LoomWin]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
if (-not $ok) { $g.Dispose(); $bmp.Dispose(); Write-Error "PrintWindow failed"; exit 1 }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ($w x $ht)"
