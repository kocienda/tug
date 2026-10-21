import WebKit

// MARK: - PageFaultScript
//
// Installs a `WKUserScript` at `atDocumentStart` that forwards the page's
// own faults — an uncaught `error`, an `unhandledrejection`, and every
// `console.error` — to the `pageFault` message handler, which writes them
// to `tugapp.log` under the `webview` subsystem.
//
// Why it exists: the app has no Web Inspector in any build, and the deck
// reaches the native log only through `frontendReady` and the boot-horizon
// report, both of which live in `main.tsx`'s boot path. A module that
// throws while it is being evaluated sends neither, so a launch that
// stalled that way logged `reason=no reason given` and nothing else
// (2026-10-08). This is the channel that fault was missing.
//
// It runs in every build, not only DEBUG: a release launch that stalls
// deserves the same line, and the cost is one listener per event.

enum PageFaultScript {
    /// The longest text one fault may carry into the log. A stack is
    /// wanted; a 2 MB stringified object is not.
    private static let maxChars = 4000

    static func install(into config: WKWebViewConfiguration) {
        let source = """
        (function () {
          var MAX = \(maxChars);
          function text(v) {
            try {
              if (v instanceof Error) return (v.name || "Error") + ": " + v.message + (v.stack ? "\\n" + v.stack : "");
              if (typeof v === "string") return v;
              return JSON.stringify(v);
            } catch (e) { return String(v); }
          }
          function post(kind, message, source) {
            try {
              var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pageFault;
              if (!h) return;
              h.postMessage({ kind: kind, message: String(message).slice(0, MAX), source: source || "" });
            } catch (e) {}
          }
          window.addEventListener("error", function (e) {
            // A thrown exception arrives on `window` with a message and a
            // file; a resource that failed to load fires on its element
            // and arrives here only because this listener captures, with
            // neither. Name the element, or the fault reads as "error".
            var t = e.target;
            if (t && t !== window && t.tagName) {
              var url = t.src || t.href || "";
              post("resource", t.tagName.toLowerCase() + " failed to load", url);
              return;
            }
            var where = (e.filename || "") + (e.lineno ? ":" + e.lineno + ":" + (e.colno || 0) : "");
            post("error", e.error ? text(e.error) : (e.message || "error"), where);
          }, true);
          window.addEventListener("unhandledrejection", function (e) {
            post("unhandledrejection", text(e.reason));
          });
          var original = console.error;
          console.error = function () {
            var parts = [];
            for (var i = 0; i < arguments.length; i += 1) parts.push(text(arguments[i]));
            post("console.error", parts.join(" "));
            return original.apply(this, arguments);
          };
          // The boot watchdog, on the shell page only: a page that has not
          // reached `frontend-ready` by each mark reports where its load
          // stands — how many resources it holds, how many are still open,
          // the last few it asked for, and the last boot lap it posted
          // (`__tugBootLap`, written by main.tsx's `lap`) — because a launch
          // that stalls with no error, no socket and no lap is otherwise
          // unreadable (2026-10-21). The buffer is raised first so the count
          // is the whole graph, not the default 250.
          if (!/[?&](body|overlay)=/.test(window.location.search)) {
            try { performance.setResourceTimingBufferSize(4000); } catch (e) {}
            var census = function (mark) {
              try {
                var rs = performance.getEntriesByType("resource");
                var open = 0;
                for (var i = 0; i < rs.length; i += 1) { if (!rs[i].responseEnd) open += 1; }
                var last = [];
                var tail = rs.slice(-5);
                for (var j = 0; j < tail.length; j += 1) {
                  last.push(tail[j].name.replace(/^[a-z]+:\\/\\/[^/]+/, "") + "@" + Math.round(tail[j].startTime) + (tail[j].responseEnd ? "" : "(open)"));
                }
                post("stall", "boot watchdog " + mark + "s: lap=" + (window.__tugBootLap || "none") + " readyState=" + document.readyState + " resources=" + rs.length + " open=" + open + " now=" + Math.round(performance.now()) + " last=" + last.join(", "));
              } catch (e) {
                post("stall", "boot watchdog " + mark + "s: census failed: " + text(e));
              }
            };
            var arm = function (mark) {
              setTimeout(function () { if (window.__tugBootLap !== "frontend-ready") census(mark); }, mark * 1000);
            };
            arm(15);
            arm(40);
          }
        })();
        """
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)
    }

    /// Write one fault the page posted. Called from the message handler.
    static func log(_ fault: PageFault) {
        // One line per fault: the log is line-oriented and a stack's own
        // newlines would read as separate, subsystem-less entries.
        let flat = fault.message.replacingOccurrences(of: "\n", with: " | ")
        var fields = [TugLog.field("kind", fault.kind.rawValue)]
        if !fault.source.isEmpty { fields.append(TugLog.field("source", fault.source)) }
        fields.append(TugLog.field("message", flat))
        TugLog.error("webview", "page fault", fields)
    }
}
