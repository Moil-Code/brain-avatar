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

// Strip any trailing " (Premium)"/" (Enhanced)" labels (one or more) from a voice name.
func stripQuality(_ s: String) -> String {
    var n = s
    while true {
        var changed = false
        for suf in [" (Premium)", " (Enhanced)"] where n.hasSuffix(suf) {
            n = String(n.dropLast(suf.count))
            changed = true
        }
        if !changed { break }
    }
    return n
}

if args.count > 1 && args[1] == "--list" {
    var seen = Set<String>()
    for v in sortedVoices() where v.language.hasPrefix("en") {
        // AVSpeechSynthesisVoice.name for Enhanced/Premium voices ALREADY includes the
        // tier (e.g. "Zoe (Premium)"). Strip it before re-appending exactly one, so the
        // label isn't doubled ("Zoe (Premium) (Premium)") — the bug that made the picker
        // save unresolvable names and fall back to the robotic default voice.
        let base = stripQuality(v.name)
        let q = v.quality == .premium ? " (Premium)" : (v.quality == .enhanced ? " (Enhanced)" : "")
        let label = "\(base)\(q)"
        if !seen.insert(label).inserted { continue }
        print(label)
    }
    exit(0)
}

let voiceArg = args.count > 1 ? args[1] : ""
let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
if text.isEmpty { exit(0) }

let synth = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: text)

// Resolve the requested voice. Try an exact name/identifier match first (clean names
// like "Zoe (Premium)"), then fall back to a base-name match with all quality suffixes
// stripped — so legacy doubled names ("Zoe (Premium) (Premium)") still resolve.
// sortedVoices() is quality-descending, so the best variant wins on a base match.
if !voiceArg.isEmpty {
    let voices = sortedVoices()
    let target = stripQuality(voiceArg)
    if let v = voices.first(where: { $0.name == voiceArg || $0.identifier == voiceArg })
        ?? voices.first(where: { stripQuality($0.name) == target }) {
        utterance.voice = v
    }
}

final class Done: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { exit(0) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { exit(0) }
}
let done = Done()
synth.delegate = done
synth.speak(utterance)
RunLoop.main.run()
