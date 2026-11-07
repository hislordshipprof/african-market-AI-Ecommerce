use std::env;
use std::fs::OpenOptions;
use std::io::{self, Write};
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
