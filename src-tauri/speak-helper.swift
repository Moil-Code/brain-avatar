// Neural text-to-speech helper for Brain Avatar. Uses AVSpeechSynthesizer (which
// can use macOS Premium/Enhanced "Siri" voices) instead of the legacy `say`, which
// only reaches the older robotic voices. Bundled as a Tauri sidecar.
//
//   speak-helper --list                 -> one "Name (Quality)" per line, Premium first
//   speak-helper "Zoe (Premium)" <stdin -> speaks stdin text with that voice
//   speak-helper "" <stdin              -> speaks with the default voice
import AVFoundation
import Foundation

let args = CommandLine.arguments

// Voices sorted so higher quality (Premium > Enhanced > Default) comes first.
func sortedVoices() -> [AVSpeechSynthesisVoice] {
    AVSpeechSynthesisVoice.speechVoices().sorted { $0.quality.rawValue > $1.quality.rawValue }
}

if args.count > 1 && args[1] == "--list" {
    var seen = Set<String>()
    for v in sortedVoices() where v.language.hasPrefix("en") {
        if !seen.insert(v.name).inserted { continue }
        let q = v.quality == .premium ? " (Premium)" : (v.quality == .enhanced ? " (Enhanced)" : "")
        print("\(v.name)\(q)")
    }
    exit(0)
}

let voiceArg = args.count > 1 ? args[1] : ""
let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
if text.isEmpty { exit(0) }

let synth = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: text)

// Strip any " (Premium)"/" (Enhanced)" label the picker added, then match by name
// or identifier — sortedVoices() ensures the highest-quality match wins.
var name = voiceArg
for suffix in [" (Premium)", " (Enhanced)"] where name.hasSuffix(suffix) {
    name = String(name.dropLast(suffix.count)); break
}
if !name.isEmpty,
   let v = sortedVoices().first(where: { $0.name == name || $0.identifier == name }) {
    utterance.voice = v
}

final class Done: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { exit(0) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { exit(0) }
}
let done = Done()
synth.delegate = done
synth.speak(utterance)
RunLoop.main.run()
