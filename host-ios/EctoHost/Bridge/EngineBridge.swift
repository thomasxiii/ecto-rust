// Swift wrapper around the Rust engine's C FFI surface. Mirrors the
// shape of the TS `Engine` wrapper at `web/src/engine.ts` — every
// method JSON-encodes the input, hands it to Rust, and JSON-decodes
// the response. The same JSON shapes are used in both hosts, so a
// graph imported on the web can be loaded on iOS and vice versa.
//
// To use this file in an Xcode project:
//
//   1. Build the static lib for your target:
//        cargo build --release --target aarch64-apple-ios          (device)
//        cargo build --release --target aarch64-apple-ios-sim      (sim, M-series)
//        cargo build --release --target x86_64-apple-ios            (sim, Intel)
//
//   2. Add `target/<triple>/release/libecto_engine.a` to the Xcode
//      target's "Frameworks, Libraries, and Embedded Content".
//
//   3. Add a bridging header containing:
//        #include "ecto_engine.h"
//      and point the Swift Compiler "Objective-C Bridging Header"
//      build setting at it.
//
//   4. Add `-lc++` to "Other Linker Flags" (lightningcss needs it).

import Foundation

public enum EngineError: Error {
    case nullReturn
    case rustError(String)
    case decodeError(String)
}

public final class EctoEngine {
    private let inner: OpaquePointer

    public init() {
        guard let ptr = ecto_engine_new() else {
            fatalError("ecto_engine_new returned null")
        }
        self.inner = ptr
    }

    deinit {
        ecto_engine_free(inner)
    }

    public static var version: String {
        guard let cstr = ecto_engine_version() else { return "?" }
        defer { ecto_string_free(cstr) }
        return String(cString: cstr)
    }

    // MARK: - Core graph ops

    public func loadGraph(_ payload: Data) throws {
        _ = try call(ecto_engine_load_graph, payload)
    }

    public func getGraph() throws -> Data {
        return try call0(ecto_engine_get_graph)
    }

    public func importFiles(projectName: String, filesJSON: Data) throws -> Data {
        return try projectName.withCString { name in
            try filesJSON.withCString { files in
                try take(ecto_engine_import_files(inner, name, files))
            }
        }
    }

    public func applyMutation(_ mutationJSON: Data) throws -> Data {
        return try call(ecto_engine_apply_mutation, mutationJSON)
    }

    public func applyAgentOp(projectId: String, opJSON: Data) throws -> Data {
        return try projectId.withCString { pid in
            try opJSON.withCString { op in
                try take(ecto_engine_apply_agent_op(inner, pid, op))
            }
        }
    }

    public func walkRenderTree(rootId: String) throws -> Data {
        return try rootId.withCString { root in
            try take(ecto_engine_walk_render_tree(inner, root))
        }
    }

    public func generateStylesheet() throws -> Data {
        return try call0(ecto_engine_generate_stylesheet)
    }

    public func buildSemanticLayer(projectId: String) throws -> Data {
        return try projectId.withCString { pid in
            try take(ecto_engine_build_semantic_layer(inner, pid))
        }
    }

    public func buildUiLayer(projectId: String) throws -> Data {
        return try projectId.withCString { pid in
            try take(ecto_engine_build_ui_layer(inner, pid))
        }
    }

    // MARK: - Internals

    private func call(
        _ fn: (OpaquePointer, UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?,
        _ payload: Data,
    ) throws -> Data {
        return try payload.withCString { json in
            try take(fn(inner, json))
        }
    }

    private func call0(_ fn: (OpaquePointer) -> UnsafeMutablePointer<CChar>?) throws -> Data {
        return try take(fn(inner))
    }

    private func take(_ cstrPtr: UnsafeMutablePointer<CChar>?) throws -> Data {
        guard let cstr = cstrPtr else { throw EngineError.nullReturn }
        defer { ecto_string_free(cstr) }
        let str = String(cString: cstr)
        // Rust wraps unrecoverable errors as `{"error": "..."}` JSON.
        // Detect that and translate to a Swift error.
        if let data = str.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let err = obj["error"] as? String,
           obj.count == 1
        {
            throw EngineError.rustError(err)
        }
        guard let data = str.data(using: .utf8) else {
            throw EngineError.decodeError("string-not-utf8")
        }
        return data
    }
}

// MARK: - Data → C-string adapter
//
// Data isn't null-terminated, so `withUnsafeBytes` won't satisfy a
// `const char *` parameter. We copy into a temporary CString for the
// duration of the call. The Rust side parses JSON which doesn't care
// about trailing data, so the null terminator is just decoration.
private extension Data {
    func withCString<R>(_ body: (UnsafePointer<CChar>) throws -> R) rethrows -> R {
        // Force-add a trailing null byte for C-string consumers.
        var copy = self
        copy.append(0)
        return try copy.withUnsafeBytes { raw in
            let ptr = raw.bindMemory(to: CChar.self).baseAddress!
            return try body(ptr)
        }
    }
}
