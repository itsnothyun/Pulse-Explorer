//! Named sets of tabs, saved and opened again (a JSON file in the app's settings folder).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub tabs: Vec<String>,
    pub active: usize,
}

pub struct Store {
    file: PathBuf,
}

impl Store {
    pub fn new(file: &Path) -> Self {
        Self { file: file.to_path_buf() }
    }

    pub fn all(&self) -> Vec<Workspace> {
        let mut v: Vec<Workspace> = std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        v.sort_by_key(|w| w.name.to_lowercase());
        v
    }

    /// Saves (or replaces, same name ignoring case); empty names and empty tab lists are refused.
    pub fn save(&self, w: Workspace) -> bool {
        let name = w.name.trim().to_string();
        if name.is_empty() || w.tabs.is_empty() {
            return false;
        }
        let mut list: Vec<Workspace> = self.all().into_iter().filter(|x| x.name.to_lowercase() != name.to_lowercase()).collect();
        let active = w.active.min(w.tabs.len() - 1);
        list.push(Workspace { name, tabs: w.tabs, active });
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        serde_json::to_string_pretty(&list).ok().is_some_and(|t| std::fs::write(&self.file, t).is_ok())
    }

    pub fn remove(&self, name: &str) {
        let list: Vec<Workspace> = self.all().into_iter().filter(|x| x.name.to_lowercase() != name.to_lowercase()).collect();
        let _ = serde_json::to_string_pretty(&list).map(|t| std::fs::write(&self.file, t));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_replace_remove_validate() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(&d.path().join("ws.json"));
        assert!(!s.save(Workspace { name: "  ".into(), tabs: vec!["a".into()], active: 0 }));
        assert!(!s.save(Workspace { name: "E".into(), tabs: vec![], active: 0 }));
        assert!(s.save(Workspace { name: " Film ".into(), tabs: vec!["a".into(), "b".into()], active: 9 }));
        assert_eq!(s.all()[0].active, 1);
        assert!(s.save(Workspace { name: "film".into(), tabs: vec!["c".into()], active: 0 }));
        assert_eq!(s.all().len(), 1);
        assert!(s.save(Workspace { name: "Alpha".into(), tabs: vec!["x".into()], active: 0 }));
        assert_eq!(s.all().iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), ["Alpha", "film"]);
        s.remove("ALPHA");
        assert_eq!(s.all().len(), 1);
    }
}
