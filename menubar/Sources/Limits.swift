import Foundation

struct Limit: Decodable, Identifiable {
    let label: String
    let percent: Double
    let resetsAt: Date?

    var id: String { label }
}

struct Account: Decodable, Identifiable {
    /// Absent for the default login in ~/.claude.
    let dir: String?
    let email: String?
    let plan: String?
    let limits: [Limit]
    let error: String?

    var id: String { dir ?? "default" }
    var name: String { email ?? dir.map { ($0 as NSString).lastPathComponent } ?? "Default login" }
    /// The limit closest to running out, which is the one that stops the account.
    var highest: Double? { limits.map(\.percent).max() }
}

struct Report: Decodable {
    let accounts: [Account]
    let error: String?
}

@MainActor
final class Limits: ObservableObject {
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var failure: String?
    @Published private(set) var loading = false
    private var loaded: Date?

    init() {
        refresh()
        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in self.refresh() }
        }
    }

    /// The menu opens with numbers from the last timer tick, so read again when they are over a minute old.
    func refreshIfStale() {
        if let loaded, Date().timeIntervalSince(loaded) < 60 { return }
        refresh()
    }

    func refresh() {
        if loading { return }
        loading = true
        Task {
            let result = await Task.detached { Limits.read() }.value
            loading = false
            loaded = Date()
            switch result {
            case .success(let report):
                accounts = report.accounts
                failure = report.error
            case .failure(let error):
                failure = error.message
            }
        }
    }

    struct Failure: Error {
        let message: String
    }

    /// `-command '("/path/to/tool", "arg")'` on launch overrides the command the build wrote into Info.plist.
    nonisolated private static func command() -> [String] {
        UserDefaults.standard.stringArray(forKey: "command")
            ?? Bundle.main.object(forInfoDictionaryKey: "LimitsCommand") as? [String]
            ?? []
    }

    nonisolated private static func read() -> Result<Report, Failure> {
        let command = command()
        guard let tool = command.first else {
            return .failure(Failure(message: "No limits command is set. Rebuild with menubar/build.sh."))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = Array(command.dropFirst())
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        do {
            try process.run()
        } catch {
            return .failure(Failure(message: "Could not run \(tool): \(error.localizedDescription)"))
        }
        // Each account answers within 30 seconds or reports its own error, so a longer wait means the tool is stuck.
        let stuck = DispatchWorkItem { process.terminate() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: stuck)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let problem = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        stuck.cancel()

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            return try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)
        }
        if let report = try? decoder.decode(Report.self, from: data) { return .success(report) }
        let detail = String(data: problem, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .failure(Failure(message: detail.isEmpty ? "The limits command returned no data." : detail))
    }
}
