use std::env;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::Path;

fn main() {
    let args: Vec<String> = env::args().collect();
    let name = Path::new(args.first().map(String::as_str).unwrap_or(""))
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    match name.as_str() {
        "pg_ctl" | "pg_isready" => {}
        "psql" => append("psql\n"),
        "git" => git(&args),
        "gh" => gh(&args),
        "claude" => {
            append(&child_line("claude"));
            println!("{}", r#"{"session_id":"stub-session-0001"}"#);
        }
        // These names are MSYS binaries on Git bash. Each startup is a process, and
        // under a full CPU that startup is most of the 15s and 180s budgets. The
        // bodies below are the invocations lane-db.sh and build-ticket.sh actually
        // make. Anything else exits 2, so a new flag fails the test instead of
        // pretending to succeed.
        "dirname" => dirname_cmd(&args),
        "mktemp" => mktemp_cmd(&args),
        "cat" => cat_cmd(&args),
        "mv" => mv_cmd(&args),
        "grep" => grep_cmd(&args),
        "date" => date_cmd(&args),
        "ls" => ls_cmd(&args),
        "mkdir" => mkdir_cmd(&args),
        "rm" => rm_cmd(&args),
        "tail" => tail_cmd(&args),
        "tr" => tr_cmd(&args),
        "sed" => sed_cmd(&args),
        "cut" => cut_cmd(&args),
        other => append(&child_line(other)),
    }
}

fn git(args: &[String]) {
    if args.get(1).map(String::as_str) == Some("rev-parse") {
        // The path is pipe-encoded so MSYS does not rewrite /c/... into C:/...
        // before this native exe sees it. build-ticket.sh wants the bash path.
        if let Ok(root) = env::var("STUB_GIT_ROOT") {
            println!("{}", root.replace('|', "/"));
        }
        return;
    }
    let rest = args.iter().skip(1).map(String::as_str).collect::<Vec<_>>().join(" ");
    append(&format!("git {rest}\n"));
}

fn gh(args: &[String]) {
    let joined = args.iter().skip(1).map(String::as_str).collect::<Vec<_>>().join(" ");
    if joined.contains("blocked_by") {
        return;
    }
    let line = if joined.contains("comments") {
        "agent brief"
    } else if joined.contains("title") {
        "seed photos"
    } else {
        "OPEN"
    };
    println!("{line}");
}

fn child_line(label: &str) -> String {
    format!(
        "child {label} host={} secret={} access={} unpooled={} prune={}\n",
        host(),
        flag("R2_SECRET_ACCESS_KEY"),
        flag("R2_ACCESS_KEY_ID"),
        flag("DATABASE_URL_UNPOOLED"),
        flag("SEED_PRUNE_R2"),
    )
}

fn host() -> String {
    let Ok(url) = env::var("DATABASE_URL") else {
        return "missing".into();
    };
    if url.is_empty() {
        return "missing".into();
    }
    let rest = url.rfind('@').map(|i| &url[i + 1..]).unwrap_or_else(|| {
        url.find("://").map(|i| &url[i + 3..]).unwrap_or(url.as_str())
    });
    let end = rest.find([':', '/']).unwrap_or(rest.len());
    let host = &rest[..end];
    if host.is_empty() { "missing".into() } else { host.into() }
}

fn flag(name: &str) -> &'static str {
    match env::var(name) {
        Ok(value) if !value.is_empty() => "present",
        _ => "",
    }
}

fn append(line: &str) {
    let Ok(path) = env::var("HARNESS_LOG") else {
        return;
    };
    if path.is_empty() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
    let _ = io::stdout().flush();
}

fn die(code: i32) -> ! {
    std::process::exit(code);
}

fn dirname_cmd(args: &[String]) {
    let Some(arg) = args.get(1).filter(|s| !s.is_empty()) else { die(1); };
    if args.len() != 2 { die(2); }
    let trimmed = arg.trim_end_matches(['/', '\\']);
    let parent = match trimmed.rfind(['/', '\\']) {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].replace('\\', "/"),
        None => ".".to_string(),
    };
    let parent = if parent.ends_with(':') { format!("{parent}/") } else { parent };
    println!("{parent}");
}

fn mktemp_cmd(args: &[String]) {
    if args.len() != 1 { die(2); }
    let dir = env::temp_dir();
    for n in 1..1000 {
        let name = format!("tmp.{}.{}", std::process::id(), n);
        let path = dir.join(&name);
        if OpenOptions::new().write(true).create_new(true).open(&path).is_ok() {
            println!("/tmp/{name}");
            return;
        }
    }
    die(1);
}

fn cat_cmd(args: &[String]) {
    if args.len() < 2 { die(1); }
    let mut out = io::stdout().lock();
    for path in args.iter().skip(1) {
        if path.starts_with('-') { die(2); }
        let bytes = std::fs::read(path).unwrap_or_else(|_| die(1));
        out.write_all(&bytes).unwrap_or_else(|_| die(1));
    }
    let _ = out.flush();
}

fn mv_cmd(args: &[String]) {
    if args.len() != 3 { die(2); }
    if std::fs::rename(&args[1], &args[2]).is_ok() { return; }
    if std::fs::copy(&args[1], &args[2]).is_err() { die(1); }
    if std::fs::remove_file(&args[1]).is_err() { die(1); }
}

#[repr(C)]
struct WinSystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLocalTime(out: *mut WinSystemTime);
}

fn date_cmd(args: &[String]) {
    if args.get(1).map(String::as_str) != Some("+%Y%m%d-%H%M%S") || args.len() != 2 { die(2); }
    let mut now = WinSystemTime {
        year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0,
    };
    unsafe { GetLocalTime(&mut now); }
    println!("{:04}{:02}{:02}-{:02}{:02}{:02}", now.year, now.month, now.day, now.hour, now.minute, now.second);
}

fn ls_cmd(args: &[String]) {
    if args.len() < 2 { die(2); }
    let mut missing = false;
    for path in args.iter().skip(1) {
        if path.starts_with('-') { die(2); }
        if std::fs::metadata(path).is_ok() {
            println!("{path}");
        } else {
            missing = true;
        }
    }
    if missing { die(2); }
}

fn mkdir_cmd(args: &[String]) {
    if args.get(1).map(String::as_str) != Some("-p") || args.len() < 3 { die(2); }
    for path in args.iter().skip(2) {
        if std::fs::create_dir_all(path).is_err() { die(1); }
    }
}

fn rm_cmd(args: &[String]) {
    if args.get(1).map(String::as_str) != Some("-f") || args.len() < 3 { die(2); }
    for path in args.iter().skip(2) {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(_) => die(1),
        }
    }
}

fn tail_cmd(args: &[String]) {
    let mut n: usize = 10;
    let mut files: Vec<&str> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if let Some(rest) = arg.strip_prefix("-n") {
            if rest.is_empty() {
                i += 1;
                n = args.get(i).and_then(|s| s.parse().ok()).unwrap_or_else(|| die(2));
            } else {
                n = rest.parse().unwrap_or_else(|_| die(2));
            }
        } else if arg.starts_with('-') && arg.len() > 1 && arg[1..].chars().all(|c| c.is_ascii_digit()) {
            n = arg[1..].parse().unwrap_or_else(|_| die(2));
        } else {
            files.push(arg);
        }
        i += 1;
    }
    if files.len() > 1 { die(2); }
    let bytes = if let Some(path) = files.first() {
        std::fs::read(path).unwrap_or_else(|_| die(1))
    } else {
        let mut buf = Vec::new();
        io::stdin().read_to_end(&mut buf).unwrap_or_else(|_| die(1));
        buf
    };
    let text = String::from_utf8_lossy(&bytes);
    print!("{}", last_lines(&text, n));
}

fn last_lines(text: &str, n: usize) -> String {
    if n == 0 { return String::new(); }
    let ended = text.ends_with('\n');
    let mut lines: Vec<&str> = text.split('\n').collect();
    if ended {
        if lines.last().map(|s| s.is_empty()).unwrap_or(false) { lines.pop(); }
    }
    let start = lines.len().saturating_sub(n);
    let mut out = lines[start..].join("\n");
    if !out.is_empty() { out.push('\n'); }
    out
}

fn tr_cmd(args: &[String]) {
    if args.len() != 3 || args[1] != "[:upper:]" || args[2] != "[:lower:]" { die(2); }
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf).unwrap_or_else(|_| die(1));
    for byte in &mut buf {
        if byte.is_ascii_uppercase() { *byte = byte.to_ascii_lowercase(); }
    }
    let mut out = io::stdout().lock();
    out.write_all(&buf).unwrap_or_else(|_| die(1));
}

fn sed_cmd(args: &[String]) {
    const SCRIPT: &str = "s/[^a-z0-9]+/-/g; s/^-|-$//g";
    if args.len() != 3 || args[1] != "-E" || args[2] != SCRIPT { die(2); }
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf).unwrap_or_else(|_| die(1));
    let text = String::from_utf8_lossy(&buf);
    let ended = text.ends_with('\n');
    let mut lines: Vec<&str> = text.split('\n').collect();
    if ended && lines.last().map(|s| s.is_empty()).unwrap_or(false) { lines.pop(); }
    let mut out = String::new();
    for line in lines {
        let mut slug = String::new();
        let mut dash = false;
        for c in line.chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                slug.push(c);
                dash = false;
            } else if !dash {
                slug.push('-');
                dash = true;
            }
        }
        let slug = slug.trim_matches('-');
        out.push_str(slug);
        out.push('\n');
    }
    print!("{out}");
}

fn cut_cmd(args: &[String]) {
    if args.len() != 2 || args[1] != "-c1-40" { die(2); }
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf).unwrap_or_else(|_| die(1));
    let text = String::from_utf8_lossy(&buf);
    let ended = text.ends_with('\n');
    let mut lines: Vec<&str> = text.split('\n').collect();
    if ended && lines.last().map(|s| s.is_empty()).unwrap_or(false) { lines.pop(); }
    let mut out = String::new();
    for line in lines {
        let cut: String = line.chars().take(40).collect();
        out.push_str(&cut);
        out.push('\n');
    }
    print!("{out}");
}

#[derive(Clone)]
enum Atom {
    Any,
    Bol,
    Eol,
    Lit(char),
    Class { neg: bool, set: Vec<char> },
    Star(Box<Atom>),
    Plus(Box<Atom>),
}

fn grep_cmd(args: &[String]) {
    let mut icase = false;
    let mut extended = false;
    let mut quiet = false;
    let mut invert = false;
    let mut count = false;
    let mut i = 1;
    while i < args.len() && args[i].starts_with('-') && args[i] != "-" {
        for flag in args[i].chars().skip(1) {
            match flag {
                'i' => icase = true,
                'E' => extended = true,
                'q' => quiet = true,
                'v' => invert = true,
                'c' => count = true,
                _ => die(2),
            }
        }
        i += 1;
    }
    let Some(pattern) = args.get(i) else { die(2); };
    i += 1;
    let alts = parse_alts(pattern, extended).unwrap_or_else(|_| die(2));
    let files: Vec<&str> = args[i..].iter().map(String::as_str).collect();
    let inputs: Vec<Vec<u8>> = if files.is_empty() {
        let mut buf = Vec::new();
        io::stdin().read_to_end(&mut buf).unwrap_or_else(|_| die(1));
        vec![buf]
    } else {
        files.iter().map(|path| std::fs::read(path).unwrap_or_else(|_| die(2))).collect()
    };
    let mut selected = 0usize;
    for input in inputs {
        let text = String::from_utf8_lossy(&input);
        let ended = text.ends_with('\n');
        let mut lines: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
        if ended && lines.last().map(|s| s.is_empty()).unwrap_or(false) { lines.pop(); }
        for line in lines {
            let hit = alts.iter().any(|alt| alt_matches(alt, line, icase));
            if hit ^ invert {
                selected += 1;
                if quiet { die(0); }
                if !count { println!("{line}"); }
            }
        }
    }
    if count { println!("{selected}"); }
    die(if selected > 0 { 0 } else { 1 });
}

fn parse_alts(pat: &str, extended: bool) -> Result<Vec<Vec<Atom>>, ()> {
    let chars: Vec<char> = pat.chars().collect();
    let mut alts = Vec::new();
    let mut cur = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if extended && c == '|' {
            alts.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        if c == '\\' {
            i += 1;
            if i >= chars.len() { return Err(()); }
            cur.push(Atom::Lit(chars[i]));
            i += 1;
            apply_quant(&mut cur, &chars, &mut i, extended);
            continue;
        }
        if c == '[' {
            let (class, next) = parse_class(&chars, i)?;
            cur.push(class);
            i = next;
            apply_quant(&mut cur, &chars, &mut i, extended);
            continue;
        }
        if c == '.' {
            cur.push(Atom::Any);
            i += 1;
            apply_quant(&mut cur, &chars, &mut i, extended);
            continue;
        }
        if c == '^' && cur.is_empty() {
            cur.push(Atom::Bol);
            i += 1;
            continue;
        }
        if c == '$' && (i + 1 == chars.len() || (extended && chars.get(i + 1) == Some(&'|'))) {
            cur.push(Atom::Eol);
            i += 1;
            continue;
        }
        cur.push(Atom::Lit(c));
        i += 1;
        apply_quant(&mut cur, &chars, &mut i, extended);
    }
    alts.push(cur);
    Ok(alts)
}

fn parse_class(chars: &[char], start: usize) -> Result<(Atom, usize), ()> {
    let mut i = start + 1;
    if i >= chars.len() { return Err(()); }
    let neg = chars[i] == '^';
    if neg { i += 1; }
    let mut set = Vec::new();
    while i < chars.len() && chars[i] != ']' {
        if i + 2 < chars.len() && chars[i + 1] == '-' && chars[i + 2] != ']' {
            let (lo, hi) = if chars[i] <= chars[i + 2] { (chars[i], chars[i + 2]) } else { (chars[i + 2], chars[i]) };
            let mut c = lo;
            loop {
                set.push(c);
                if c == hi || set.len() > 512 { break; }
                c = char::from_u32(c as u32 + 1).unwrap_or(hi);
            }
            if set.len() > 512 { return Err(()); }
            i += 3;
        } else {
            set.push(chars[i]);
            i += 1;
        }
    }
    if i >= chars.len() || chars[i] != ']' { return Err(()); }
    Ok((Atom::Class { neg, set }, i + 1))
}

fn apply_quant(cur: &mut Vec<Atom>, chars: &[char], i: &mut usize, extended: bool) {
    if *i >= chars.len() { return; }
    let star = chars[*i] == '*';
    let plus = extended && chars[*i] == '+';
    if !star && !plus { return; }
    let Some(prev) = cur.pop() else { return; };
    if matches!(prev, Atom::Bol | Atom::Eol | Atom::Star(_) | Atom::Plus(_)) {
        cur.push(prev);
        return;
    }
    cur.push(if star { Atom::Star(Box::new(prev)) } else { Atom::Plus(Box::new(prev)) });
    *i += 1;
}

fn alt_matches(alt: &[Atom], line: &str, icase: bool) -> bool {
    let text: Vec<char> = line.chars().collect();
    if alt.first().is_some_and(|atom| matches!(atom, Atom::Bol)) {
        return match_seq(alt, &text, 0, icase);
    }
    (0..=text.len()).any(|start| match_seq(alt, &text, start, icase))
}

fn match_seq(atoms: &[Atom], text: &[char], i: usize, icase: bool) -> bool {
    let Some(first) = atoms.first() else { return true; };
    let rest = &atoms[1..];
    match first {
        Atom::Bol => i == 0 && match_seq(rest, text, i, icase),
        Atom::Eol => i == text.len() && match_seq(rest, text, i, icase),
        Atom::Star(inner) => {
            let mut positions = vec![i];
            let mut j = i;
            while let Some(n) = eat(inner, text, j, icase) {
                if n == j { break; }
                j = n;
                positions.push(j);
            }
            positions.iter().rev().any(|p| match_seq(rest, text, *p, icase))
        }
        Atom::Plus(inner) => {
            let Some(mut j) = eat(inner, text, i, icase) else { return false; };
            let mut positions = vec![j];
            while let Some(n) = eat(inner, text, j, icase) {
                if n == j { break; }
                j = n;
                positions.push(j);
            }
            positions.iter().rev().any(|p| match_seq(rest, text, *p, icase))
        }
        other => eat(other, text, i, icase).is_some_and(|n| match_seq(rest, text, n, icase)),
    }
}

fn eat(atom: &Atom, text: &[char], i: usize, icase: bool) -> Option<usize> {
    let ch = *text.get(i)?;
    let ok = match atom {
        Atom::Any => true,
        Atom::Lit(expected) => fold(ch, icase) == fold(*expected, icase),
        Atom::Class { neg, set } => set.iter().any(|c| fold(*c, icase) == fold(ch, icase)) ^ *neg,
        _ => return None,
    };
    if ok { Some(i + 1) } else { None }
}

fn fold(c: char, icase: bool) -> char {
    if icase { c.to_ascii_lowercase() } else { c }
}
