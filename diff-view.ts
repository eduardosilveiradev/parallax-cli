// ─────────────────────────────────────────────────────────────────
//  diff-view.ts — Pretty ANSI-colored unified diff renderer
//
//  Renders diffs with colored backgrounds (GitHub-style),
//  file headers, and change stats.
// ─────────────────────────────────────────────────────────────────

// ANSI escape helpers
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// Foreground
const WHITE = "\x1b[97m";
const GREY = "\x1b[90m";
const CYAN = "\x1b[36m";

// Backgrounds
const BG_RED = "\x1b[41m";    // red bg for deletions
const BG_GREEN = "\x1b[42m";    // green bg for additions
const BG_DARK = "\x1b[48;5;236m"; // dark grey bg for context

// Foreground on bg
const FG_ON_RED = "\x1b[97m";  // white text on red
const FG_ON_GREEN = "\x1b[30m";  // black text on green

/**
 * Render a unified diff string with ANSI colors and backgrounds.
 * Handles git, svn, and MCP filesystem diff formats.
 */
export function renderDiff(raw: string): string {
    // Strip markdown code fences if present
    let diff = raw.trim();
    if (diff.startsWith("```")) {
        diff = diff.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    }

    const lines = diff.split("\n");
    const output: string[] = [];

    // Count stats
    let additions = 0;
    let deletions = 0;
    let fileName = "";

    for (const line of lines) {
        if (line.startsWith("+++")) {
            // Extract filename from +++ line
            const name = line.replace(/^\+\+\+\s+/, "").replace(/\t.*$/, "");
            if (name && name !== "/dev/null") {
                fileName = name.replace(/^[ab]\//, "");  // strip git a/ b/ prefix
            }
        }
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    // ── File header ──
    const shortName = fileName.split(/[/\\]/).slice(-2).join("/") || "file";
    output.push("");
    output.push(`  ${BOLD}${WHITE}📄 ${shortName}${R}  ${BOLD}\x1b[32m+${additions}${R} ${BOLD}\x1b[31m-${deletions}${R}`);
    output.push(`  ${GREY}${"─".repeat(60)}${R}`);

    // ── Render lines ──
    for (const line of lines) {
        if (line.startsWith("Index:") || line.startsWith("===")) {
            continue;  // skip svn headers
        } else if (line.startsWith("diff ")) {
            continue;  // skip git diff header
        } else if (line.startsWith("---") || line.startsWith("+++")) {
            continue;  // already shown in header
        } else if (line.startsWith("@@")) {
            // Hunk header — show range info
            const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@(.*)?/);
            const context = match?.[3]?.trim() ?? "";
            output.push(`  ${CYAN}${DIM}⋮ ${line.trim()}${context ? "  " + context : ""}${R}`);
        } else if (line.startsWith("-")) {
            // Deletion — red background
            const content = line.slice(1);
            output.push(`  ${BG_RED}${FG_ON_RED} − ${content} ${R}`);
        } else if (line.startsWith("+")) {
            // Addition — green background
            const content = line.slice(1);
            output.push(`  ${BG_GREEN}${FG_ON_GREEN} + ${content} ${R}`);
        } else {
            // Context line
            const content = line.startsWith(" ") ? line.slice(1) : line;
            output.push(`  ${DIM}   ${content}${R}`);
        }
    }

    output.push(`  ${GREY}${"─".repeat(60)}${R}`);
    output.push("");

    return output.join("\n");
}
