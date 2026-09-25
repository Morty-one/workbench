/*
 * win-max-src.cs - source of scripts/win-max.exe (round 46c)
 *
 * WHY A NATIVE EXE: the bridge has to start this watcher BEFORE it opens the link (it must
 * snapshot the windows that already exist, otherwise it cannot tell "the new window" from an
 * old one). So the watcher's start-up cost sits directly on the user's click:
 *   powershell.exe -NoProfile -Command exit   ~1122 ms   <-- this is the whole problem
 *   a native .exe (this file, compiled)          64 ms
 * The PowerShell version stays as the fallback (scripts/win-max.ps1) so a machine without
 * .NET/csc still works, just slower.
 *
 * CONTRACT - must stay byte-compatible with scripts/win-max.ps1:
 *   args: --mode watch|list --proc <name> --tag <tag> --logfile <path>
 *         [--snap-file <path>] [--timeout ms] [--interval ms] [--attempts n] [--verify-delay ms]
 *   log lines (appended, no BOM):
 *     SCREEN=WxH / WORK=l,t,r,b                                     (list mode, first)
 *     HWND=<h> zoomed=<B> resizable=<B> fills=<B> rect=... delta=... title=[...]
 *     NONE proc=<name>                                              (list mode, nothing found)
 *     TAG=<tag> SNAP n=<count> proc=<name> type=exe                 (readiness marker)
 *     TAG=<tag> SKIP_NORESIZE hwnd=<h> title=[...]
 *     TAG=<tag> MAXED hwnd=<h> title=[...] attempt=<n> preZoomed=<B>
 *     TAG=<tag> NOMAX known=<n>
 *     TAG=<tag> VERIFY zoomed=<B> attempts=<n> rect=... work=... screen=... delta=...
 *   exit code 0 on every path that produced a log line (the bridge treats anything else as a
 *   timeout and still opens the link - maximizing is best-effort, opening is not).
 *
 * ASCII ONLY - it is compiled by the .NET Framework C# compiler with whatever code page this
 * machine has; keep every byte < 0x80 (same rule as the .ps1 files).
 *
 * SPEED NOTE: the PowerShell version calls Process.GetProcessById for EVERY visible top-level
 * window (~300 ms measured on this box). Here the pid set of the target process is resolved
 * once per poll with Process.GetProcessesByName, then windows of other processes are dropped
 * right after GetWindowThreadProcessId - no title read, no style read, no handle open.
 * The set is refreshed every poll on purpose: on a cold browser start the browser process
 * itself does not exist yet, so a once-computed set would never match its new window.
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class WinMax
{
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint param, out RECT data, uint winIni);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);

    private delegate bool EnumProc(IntPtr h, IntPtr p);

    private const int SW_MAXIMIZE = 3;
    private const int GWL_STYLE = -16;
    private const int WS_THICKFRAME = 0x00040000;
    private const uint SPI_GETWORKAREA = 0x0030;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int WORK_TOL = 20;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static void Main(string[] args)
    {
        string mode = "watch";
        string proc = "";
        string tag = "";
        string logFile = "";
        string snapFile = "";
        int timeoutMs = 8000;
        int intervalMs = 150;
        int attempts = 3;
        int verifyDelayMs = 450;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string v = (i + 1 < args.Length) ? args[i + 1] : "";
            if (a == "--mode") { mode = v; i++; }
            else if (a == "--proc") { proc = v; i++; }
            else if (a == "--tag") { tag = v; i++; }
            else if (a == "--logfile") { logFile = v; i++; }
            else if (a == "--snap-file") { snapFile = v; i++; }
            else if (a == "--timeout") { timeoutMs = ToInt(v, timeoutMs); i++; }
            else if (a == "--interval") { intervalMs = ToInt(v, intervalMs); i++; }
            else if (a == "--attempts") { attempts = ToInt(v, attempts); i++; }
            else if (a == "--verify-delay") { verifyDelayMs = ToInt(v, verifyDelayMs); i++; }
        }

        proc = (proc == null ? "" : proc.ToLowerInvariant());
        if (intervalMs < 10) intervalMs = 10;
        if (timeoutMs < 100 || timeoutMs > 60000) timeoutMs = 8000;
        if (attempts < 1) attempts = 1;
        if (attempts > 20) attempts = 20;
        if (verifyDelayMs < 50) verifyDelayMs = 50;
        if (verifyDelayMs > 5000) verifyDelayMs = 5000;

        if (mode == "list") { DoList(proc, logFile); return; }
        if (mode != "watch") { WriteLog(logFile, "TAG=" + tag + " ERROR=bad-mode mode=" + mode); return; }
        if (proc.Length == 0) { WriteLog(logFile, "TAG=" + tag + " ERROR=missing-proc"); return; }
        DoWatch(proc, tag, logFile, snapFile, timeoutMs, intervalMs, attempts, verifyDelayMs);
    }

    private static void DoWatch(string proc, string tag, string logFile, string snapFile,
        int timeoutMs, int intervalMs, int attempts, int verifyDelayMs)
    {
        List<IntPtr> before = All(proc);
        HashSet<long> known = new HashSet<long>();
        foreach (IntPtr h in before) known.Add(h.ToInt64());

        if (snapFile.Length > 0)
        {
            try
            {
                List<string> parts = new List<string>();
                foreach (IntPtr h in before) parts.Add(h.ToInt64().ToString());
                File.WriteAllText(snapFile, string.Join(",", parts.ToArray()), new UTF8Encoding(false));
            }
            catch { }
        }

        WriteLog(logFile, "TAG=" + tag + " SNAP n=" + before.Count + " proc=" + proc + " type=exe");

        IntPtr target = IntPtr.Zero;
        HashSet<long> skipped = new HashSet<long>();
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            List<IntPtr> now = All(proc);
            foreach (IntPtr h in now)
            {
                long k = h.ToInt64();
                if (known.Contains(k)) continue;
                if (!IsResizable(h))
                {
                    if (!skipped.Contains(k))
                    {
                        skipped.Add(k);
                        WriteLog(logFile, "TAG=" + tag + " SKIP_NORESIZE hwnd=" + k + " title=[" + Title(h) + "]");
                    }
                    continue;
                }
                target = h;
                break;
            }
            if (target != IntPtr.Zero) break;
            Thread.Sleep(intervalMs);
        }

        if (target == IntPtr.Zero)
        {
            WriteLog(logFile, "TAG=" + tag + " NOMAX known=" + before.Count);
            return;
        }

        int attempt = 0;
        bool ok = false;
        while (attempt < attempts)
        {
            attempt++;
            bool pre = IsZoomed(target);
            ShowWindow(target, SW_MAXIMIZE);
            SetForegroundWindow(target);
            WriteLog(logFile, "TAG=" + tag + " MAXED hwnd=" + target.ToInt64() + " title=[" + Title(target) +
                "] attempt=" + attempt + " preZoomed=" + (pre ? "True" : "False"));
            Thread.Sleep(verifyDelayMs);
            if (IsZoomed(target) && FillsWorkArea(target)) { ok = true; break; }
        }

        WriteLog(logFile, "TAG=" + tag + " VERIFY zoomed=" + (ok ? "True" : "False") + " attempts=" + attempt +
            " rect=" + RectStr(target) + " work=" + WorkStr() + " screen=" + ScreenStr() + " delta=" + WorkDelta(target));
    }

    private static void DoList(string proc, string logFile)
    {
        if (proc.Length == 0) { WriteLog(logFile, "TAG= ERROR=missing-proc"); return; }
        WriteLog(logFile, "SCREEN=" + ScreenStr());
        WriteLog(logFile, "WORK=" + WorkStr());
        List<IntPtr> all = All(proc);
        if (all.Count == 0) { WriteLog(logFile, "NONE proc=" + proc); return; }
        foreach (IntPtr h in all)
        {
            WriteLog(logFile, "HWND=" + h.ToInt64() + " zoomed=" + (IsZoomed(h) ? "True" : "False") +
                " resizable=" + (IsResizable(h) ? "True" : "False") +
                " fills=" + (FillsWorkArea(h) ? "True" : "False") +
                " rect=" + RectStr(h) + " delta=" + WorkDelta(h) + " title=[" + Title(h) + "]");
        }
    }

    private static HashSet<int> PidsOf(string proc)
    {
        HashSet<int> pids = new HashSet<int>();
        try
        {
            Process[] arr = Process.GetProcessesByName(proc);
            foreach (Process p in arr)
            {
                try { pids.Add(p.Id); }
                finally { try { p.Dispose(); } catch { } }
            }
        }
        catch { }
        return pids;
    }

    private static List<IntPtr> All(string proc)
    {
        HashSet<int> pids = PidsOf(proc);
        List<IntPtr> list = new List<IntPtr>();
        if (pids.Count == 0) return list;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains((int)pid)) return true;
            if (Title(h).Length == 0) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static string Title(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    private static bool IsResizable(IntPtr h)
    {
        return (GetWindowLong(h, GWL_STYLE) & WS_THICKFRAME) != 0;
    }

    private static string RectStr(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return "n/a";
        return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    }

    private static string WorkStr()
    {
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) return "n/a";
        return w.Left + "," + w.Top + "," + w.Right + "," + w.Bottom;
    }

    private static string ScreenStr()
    {
        return GetSystemMetrics(SM_CXSCREEN) + "x" + GetSystemMetrics(SM_CYSCREEN);
    }

    private static bool FillsWorkArea(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return false;
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) return false;
        int tol = WORK_TOL;
        bool covers = r.Left <= w.Left && r.Top <= w.Top && r.Right >= w.Right && r.Bottom >= w.Bottom;
        bool close = r.Left >= w.Left - tol && r.Top >= w.Top - tol && r.Right <= w.Right + tol && r.Bottom <= w.Bottom + tol;
        bool sameSize = Math.Abs((r.Right - r.Left) - (w.Right - w.Left)) <= 2 * tol
                     && Math.Abs((r.Bottom - r.Top) - (w.Bottom - w.Top)) <= 2 * tol;
        return covers && close && sameSize;
    }

    private static string WorkDelta(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return "n/a";
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) return "n/a";
        return "dL" + (r.Left - w.Left) + ",dT" + (r.Top - w.Top) + ",dR" + (r.Right - w.Right) + ",dB" + (r.Bottom - w.Bottom);
    }

    private static int ToInt(string s, int fallback)
    {
        int v;
        if (int.TryParse(s, out v)) return v;
        return fallback;
    }

    private static void WriteLog(string logFile, string text)
    {
        if (logFile == null || logFile.Length == 0) return;
        try { File.AppendAllText(logFile, text + "\r\n", new UTF8Encoding(false)); }
        catch { }
    }
}
