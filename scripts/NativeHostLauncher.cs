using System;
using System.Diagnostics;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Compiled as /target:winexe: Chrome can launch this host without a console.
// Only raw streams are copied. TextWriter would corrupt native-message bytes.
internal static class NativeHostLauncher
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref ExtendedLimits information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    private static SafeFileHandle CreateKillJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            int error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(error);
        }
        return job;
    }

    private static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }

    // Windows CRT command-line escaping. No command interpreter is involved.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { result.Append('\\', backslashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', backslashes); result.Append(c); }
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static async Task CopyAndFlush(Stream source, Stream destination)
    {
        var buffer = new byte[8192];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            await destination.WriteAsync(buffer, 0, count);
            // Native messaging keeps its pipes open between messages. In
            // particular StandardInput.BaseStream may buffer short frames;
            // flush each chunk rather than waiting for EOF or a full buffer.
            await destination.FlushAsync();
        }
    }

    private static async Task CopyInput(Stream source, Process child, SafeFileHandle job)
    {
        try { await CopyAndFlush(source, child.StandardInput.BaseStream); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { try { child.StandardInput.Close(); } catch { } }
        // Allow Node to abort its provider and clean up after Chrome disconnects.
        // A stuck provider is bounded; abrupt launcher termination is covered by
        // the kernel's KILL_ON_JOB_CLOSE policy instead of a finally handler.
        await Task.Delay(10000);
        try { if (!child.HasExited && !job.IsClosed) TerminateJobObject(job, 1); } catch { }
    }

    private static void KillOnFailure(Task copy, SafeFileHandle job)
    {
        copy.ContinueWith(delegate(Task task) {
            if (task.IsFaulted) { try { if (!job.IsClosed) TerminateJobObject(job, 1); } catch { } }
        });
    }

    private static int Main(string[] chromeArgs)
    {
        try
        {
            string node = Decode("__NODE_BASE64__");
            string script = Decode("__SCRIPT_BASE64__");
            string extensionId = "__EXTENSION_ID__";
            string codexBin = Decode("__CODEX_BASE64__");
            var arguments = new StringBuilder(Quote(script));
            arguments.Append(" --extension-id ").Append(Quote(extensionId));
            foreach (string argument in chromeArgs) arguments.Append(' ').Append(Quote(argument));
            var start = new ProcessStartInfo(node, arguments.ToString());
            start.WorkingDirectory = Path.GetDirectoryName(script);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            if (codexBin.Length > 0) start.EnvironmentVariables["CODEX_BIN"] = codexBin;
            using (SafeFileHandle job = CreateKillJob())
            using (Process child = Process.Start(start))
            {
                if (!AssignProcessToJobObject(job, child.Handle))
                {
                    int assignmentError = Marshal.GetLastWin32Error();
                    try { child.Kill(); } catch { }
                    throw new Win32Exception(assignmentError);
                }
                Task input = CopyInput(Console.OpenStandardInput(), child, job);
                Task output = CopyAndFlush(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Task error = CopyAndFlush(child.StandardError.BaseStream, Console.OpenStandardError());
                KillOnFailure(output, job);
                KillOnFailure(error, job);
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            // Diagnostics must never be written to the native protocol stream.
            try { Console.Error.WriteLine("Backlog AI native launcher: " + error.Message); } catch { }
            return 1;
        }
    }
}
