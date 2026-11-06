# Starts Perli slowed to about a quarter speed, then prints "<start time ms> <process id>".
# A job object limits it to 8 logical CPUs and to 2 CPUs' worth of time on a 16-thread PC,
# and child processes such as WebView2 inherit the same limit.
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Folder
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Capped {
    const uint CREATE_SUSPENDED = 4;
    const int BasicLimitInformation = 2;
    const int CpuRateControlInformation = 15;
    const uint LimitAffinity = 0x10;
    const uint CpuRateEnable = 1;
    const uint CpuRateHardCap = 4;

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, byte[] startup, long[] info);
    [DllImport("kernel32", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attr, IntPtr name);
    [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, byte[] info, int size);
    [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);

    static void Check(bool ok) {
        if (!ok) throw new System.ComponentModel.Win32Exception();
    }

    public static string Start(string exe, string folder, ulong affinity, uint cpuRate) {
        byte[] basic = new byte[64];
        BitConverter.GetBytes(LimitAffinity).CopyTo(basic, 16);
        BitConverter.GetBytes(affinity).CopyTo(basic, 48);

        byte[] rate = new byte[8];
        BitConverter.GetBytes(CpuRateEnable | CpuRateHardCap).CopyTo(rate, 0);
        BitConverter.GetBytes(cpuRate).CopyTo(rate, 4);

        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        Check(job != IntPtr.Zero);
        Check(SetInformationJobObject(job, BasicLimitInformation, basic, basic.Length));
        Check(SetInformationJobObject(job, CpuRateControlInformation, rate, rate.Length));

        byte[] startup = new byte[104];
        BitConverter.GetBytes(startup.Length).CopyTo(startup, 0);
        long[] info = new long[3];
        Check(CreateProcessW(exe, new StringBuilder("\"" + exe + "\" \"" + folder + "\""), IntPtr.Zero, IntPtr.Zero,
            false, CREATE_SUSPENDED, IntPtr.Zero, null, startup, info));
        Check(AssignProcessToJobObject(job, new IntPtr(info[0])));

        long started = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        ResumeThread(new IntPtr(info[1]));
        return started + " " + (uint)info[2];
    }
}
'@

[Capped]::Start($Exe, $Folder, 0xFF, 1250)
