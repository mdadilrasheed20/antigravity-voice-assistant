Add-Type -ReferencedAssemblies 'System.Speech' -TypeDefinition @'
using System;
using System.Text;
using System.Speech.Synthesis;

public class SpeechWorker {
    private static SpeechSynthesizer s = new SpeechSynthesizer();

    public static void Run() {
        s.SpeakCompleted += (sender, e) => {
            if (!e.Cancelled) {
                Console.WriteLine("EVENT:DONE");
            }
        };

        s.SpeakProgress += (sender, e) => {
            Console.WriteLine("PROGRESS:" + e.CharacterPosition);
        };

        Console.WriteLine("EVENT:READY");

        string line;
        while ((line = Console.ReadLine()) != null) {
            line = line.Trim();
            if (line.StartsWith("SPEAK_B64:")) {
                try {
                    string b64 = line.Substring(10);
                    byte[] bytes = Convert.FromBase64String(b64);
                    string text = Encoding.UTF8.GetString(bytes);
                    s.SpeakAsyncCancelAll();
                    if (s.State == SynthesizerState.Paused) s.Resume();
                    s.SpeakAsync(text);
                    Console.WriteLine("STATE:SPEAKING");
                } catch (Exception ex) {
                    Console.WriteLine("ERROR:" + ex.Message);
                }
            } else if (line.StartsWith("VOICE:")) {
                string v = line.Substring(6).Trim().ToLower();
                if (v.Contains("david")) s.SelectVoice("Microsoft David Desktop");
                else if (v.Contains("hazel")) s.SelectVoice("Microsoft Hazel Desktop");
                else s.SelectVoice("Microsoft Zira Desktop");
            } else if (line.StartsWith("RATE:")) {
                int r;
                if (int.TryParse(line.Substring(5).Trim(), out r)) s.Rate = r;
            } else if (line == "PAUSE") {
                try {
                    s.Pause();
                    Console.WriteLine("STATE:PAUSED");
                } catch (Exception ex) {
                    Console.WriteLine("ERROR:PAUSE:" + ex.Message);
                }
            } else if (line == "RESUME") {
                try {
                    s.Resume();
                    Console.WriteLine("STATE:SPEAKING");
                } catch (Exception ex) {
                    Console.WriteLine("ERROR:RESUME:" + ex.Message);
                }
            } else if (line == "STOP") {
                try {
                    s.SpeakAsyncCancelAll();
                    if (s.State == SynthesizerState.Paused) s.Resume();
                    Console.WriteLine("STATE:STOPPED");
                } catch (Exception ex) {
                    Console.WriteLine("ERROR:STOP:" + ex.Message);
                }
            } else if (line == "EXIT") {
                break;
            }
        }
    }
}
'@

[SpeechWorker]::Run()
