//! Indentation outline builder.
//!
//! Each non-blank, non-comment line becomes an `OutlineNode` whose depth
//! is determined by an indent-width stack. Mixed tabs and spaces are
//! allowed as long as the widths form a strict prefix relationship —
//! same heuristic as `parser.ts`'s `buildOutline`.

use super::lexer::tokenize_line;

#[derive(Debug, Clone)]
pub struct OutlineNode {
    pub line: usize, // 1-based
    pub col: usize,  // 1-based, col of first non-whitespace char
    pub tokens: Vec<String>,
    pub children: Vec<OutlineNode>,
}

impl OutlineNode {
    pub fn root() -> Self {
        Self {
            line: 0,
            col: 0,
            tokens: Vec::new(),
            children: Vec::new(),
        }
    }
}

/// Build the outline tree. Blank lines and `//` comment-only lines are
/// dropped. Strings inside `"..."` are *not* treated as comment-eligible.
pub fn build_outline(source: &str) -> OutlineNode {
    let mut root = OutlineNode::root();
    let mut stack: Vec<(usize, *mut OutlineNode)> = Vec::new();
    let mut indent_widths: Vec<usize> = Vec::new();
    let root_ptr: *mut OutlineNode = &mut root;
    stack.push((0, root_ptr));

    for (idx, raw_line) in source.split('\n').enumerate() {
        let line_no = idx + 1;
        // Strip trailing carriage return.
        let line_raw = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let stripped = strip_comment(line_raw);
        if stripped.trim().is_empty() {
            continue;
        }
        let indent = leading_whitespace_width(line_raw);
        let depth = depth_for_indent(&mut indent_widths, indent);
        // Trim leading whitespace before tokenizing so tokens see no
        // indent noise.
        let body = &line_raw[indent..];
        let body_clean = strip_comment(body);
        let tokens = tokenize_line(&body_clean);
        if tokens.is_empty() {
            continue;
        }
        // Pop the stack to the parent depth.
        while stack.len() > depth + 1 {
            stack.pop();
        }
        let parent_ptr = stack.last().expect("stack non-empty").1;
        let node = OutlineNode {
            line: line_no,
            col: indent + 1,
            tokens,
            children: Vec::new(),
        };
        // SAFETY: each pointer points to a node in the tree owned by
        // `root`; we only ever push to its `children` Vec which keeps
        // the tree alive. The pointer is invalidated on Vec realloc, so
        // we re-resolve the new child's pointer immediately after the
        // push.
        unsafe {
            let parent = &mut *parent_ptr;
            parent.children.push(node);
            let new_ptr: *mut OutlineNode = parent.children.last_mut().unwrap();
            stack.push((depth + 1, new_ptr));
        }
    }

    root
}

/// Count leading tab/space bytes — same as TS.
fn leading_whitespace_width(line: &str) -> usize {
    let mut n = 0;
    for b in line.as_bytes() {
        if *b == b' ' || *b == b'\t' {
            n += 1;
        } else {
            break;
        }
    }
    n
}

/// Map a raw indent count onto a discrete depth using a sorted stack of
/// observed widths. Mirrors `buildOutline`'s width-stack walk.
fn depth_for_indent(widths: &mut Vec<usize>, indent: usize) -> usize {
    if indent == 0 {
        widths.clear();
        return 0;
    }
    // Drop any deeper widths.
    while let Some(&w) = widths.last() {
        if w > indent {
            widths.pop();
        } else {
            break;
        }
    }
    // If indent doesn't yet exist on the stack, append it (must be > prev).
    if widths.last().copied() != Some(indent) {
        // If indent is strictly less than the last on stack we just
        // popped them all out so this branch only hits when indent > top.
        widths.push(indent);
    }
    widths.len()
}

/// Strip a `//` line comment, honoring string boundaries.
pub fn strip_comment(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' {
            in_str = !in_str;
            i += 1;
            continue;
        }
        if !in_str && c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            return line[..i].to_string();
        }
        i += 1;
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_comments_and_blank_lines() {
        let src = "// hi\nmodel A\n\n  state x = 1\n";
        let root = build_outline(src);
        assert_eq!(root.children.len(), 1);
        assert_eq!(root.children[0].tokens[0], "model");
        assert_eq!(root.children[0].children.len(), 1);
    }

    #[test]
    fn handles_mixed_indent() {
        let src = "model A\n  state x = 1\n\tstate y = 2\n";
        let root = build_outline(src);
        assert_eq!(root.children[0].children.len(), 2);
    }

    #[test]
    fn dedents_back_to_top_level() {
        let src = "model A\n  state x = 1\nmodel B\n  state y = 2\n";
        let root = build_outline(src);
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].children.len(), 1);
        assert_eq!(root.children[1].children.len(), 1);
    }
}
