import AppKit
import ServiceManagement
import SwiftUI

@main
struct ClaudeLimitsApp: App {
    @StateObject private var limits = Limits()

    var body: some Scene {
        MenuBarExtra {
            Panel(limits: limits)
        } label: {
            Image(nsImage: Meter.image(limits.accounts.map(\.highest)))
            Text(limits.accounts.isEmpty ? "–" : limits.accounts.map(Self.percent).joined(separator: " · "))
        }
        .menuBarExtraStyle(.window)
    }

    private static func percent(_ account: Account) -> String {
        account.highest.map { "\(Int($0.rounded()))%" } ?? "–"
    }
}

/// One small level bar per account, each filled to that account's highest limit.
enum Meter {
    static func image(_ levels: [Double?]) -> NSImage {
        let bars = max(levels.count, 1)
        let width: CGFloat = 5
        let gap: CGFloat = 2
        let height: CGFloat = 12
        let size = NSSize(width: CGFloat(bars) * width + CGFloat(bars - 1) * gap, height: height)
        let image = NSImage(size: size, flipped: false) { _ in
            for index in 0..<bars {
                let x = CGFloat(index) * (width + gap)
                NSColor.black.withAlphaComponent(0.3).setFill()
                NSBezierPath(roundedRect: NSRect(x: x, y: 0, width: width, height: height), xRadius: 1.5, yRadius: 1.5).fill()
                guard index < levels.count, let level = levels[index] else { continue }
                let filled = max(2, height * min(level, 100) / 100)
                NSColor.black.setFill()
                NSBezierPath(roundedRect: NSRect(x: x, y: 0, width: width, height: filled), xRadius: 1.5, yRadius: 1.5).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}

struct Panel: View {
    @ObservedObject var limits: Limits
    @State private var opensAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let failure = limits.failure {
                Text(failure)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(limits.accounts) { account in
                AccountView(account: account)
                Divider()
            }
            HStack(spacing: 12) {
                Button("Refresh") { limits.refresh() }
                    .disabled(limits.loading)
                    .keyboardShortcut("r")
                Toggle("Open at login", isOn: $opensAtLogin)
                    .toggleStyle(.checkbox)
                    .onChange(of: opensAtLogin) { _, enabled in
                        do {
                            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        } catch {
                            opensAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
            }
        }
        .padding(14)
        .frame(width: 380)
        .onAppear { limits.refreshIfStale() }
    }
}

struct AccountView: View {
    let account: Account
    @State private var confirming = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(account.name)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if let plan = account.plan {
                    Text(plan).foregroundStyle(.secondary)
                }
            }
            if let error = account.error {
                Text(error)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !account.limits.isEmpty {
                // Fixed columns, so the bars line up across accounts and compare at a glance.
                ForEach(account.limits) { limit in
                    HStack(spacing: 10) {
                        Text(limit.label)
                            .lineLimit(1)
                            .frame(width: 96, alignment: .leading)
                        Bar(percent: limit.percent)
                        Text("\(Int(limit.percent.rounded()))%")
                            .monospacedDigit()
                            .frame(width: 38, alignment: .trailing)
                        Text(limit.resetsAt.map(Self.resets) ?? "")
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .frame(width: 108, alignment: .leading)
                            .help(limit.resetsAt?.formatted(date: .abbreviated, time: .shortened) ?? "")
                    }
                }
            }
            if account.resettable != nil {
                if confirming {
                    // Claude Code uses the reset as soon as the command runs, so the question is asked here.
                    Text("Claude Code opens in Terminal and uses this account's limit reset right away, if it has one.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Reset now") {
                            confirming = false
                            problem = Reset.open(account)
                        }
                        Button("Cancel") { confirming = false }
                    }
                } else {
                    Button("Reset 5-hour limit…") { confirming = true }
                }
            }
            if let problem {
                Text(problem)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private static func resets(_ date: Date) -> String {
        let minutes = Int(date.timeIntervalSinceNow / 60)
        if minutes <= 0 { return "resets now" }
        if minutes < 60 { return "resets in \(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "resets in \(hours)h \(minutes % 60)m" }
        return "resets in \(hours / 24)d \(hours % 24)h"
    }
}

struct Bar: View {
    let percent: Double

    var body: some View {
        GeometryReader { box in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(color).frame(width: percent > 0 ? max(4, box.size.width * min(percent, 100) / 100) : 0)
            }
        }
        .frame(height: 6)
    }

    /// Orange from 80%, and red once the limit is reached and the plugin skips the account.
    private var color: Color {
        if percent >= 100 { return .red }
        if percent >= 80 { return .orange }
        return .primary
    }
}

/// Applying a limit reset is Claude Code's own /limit-reset command, which only runs in its terminal interface.
enum Reset {
    /// Opens Claude Code in Terminal on one account and runs /limit-reset there.
    /// - Returns: What went wrong, or nil once Terminal was asked to open.
    static func open(_ account: Account) -> String? {
        let claude = UserDefaults.standard.string(forKey: "claude")
            ?? Bundle.main.object(forInfoDictionaryKey: "ClaudePath") as? String
        guard let claude else { return "Claude Code's path is not set. Rebuild with menubar/build.sh." }
        let quote = { (text: String) in "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        do {
            // Claude Code asks once whether it trusts the folder it starts in, so start it in one that holds only this script.
            let folder = try FileManager.default
                .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Claude Limits")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let script = folder.appendingPathComponent("Reset 5-hour limit.command")
            var lines = ["#!/bin/zsh", "cd \(quote(folder.path))"]
            if let dir = account.dir { lines.append("export CLAUDE_CONFIG_DIR=\(quote(dir))") }
            lines.append("exec \(quote(claude)) /limit-reset")
            try (lines.joined(separator: "\n") + "\n").write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
            return NSWorkspace.shared.open(script) ? nil : "Could not open Terminal."
        } catch {
            return error.localizedDescription
        }
    }
}
