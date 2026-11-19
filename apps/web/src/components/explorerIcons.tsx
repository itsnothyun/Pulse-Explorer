import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  type LucideIcon,
} from 'lucide-react';

/**
 * The file manager's icon for a file category (apps/files, crates/rf-app/src/icons.rs
 * `icon_for`): the same Lucide drawings, so a file looks the same in both apps.
 */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  pdf: FileText,
  word: FileText,
  presentation: FileText,
  ebook: FileText,
  text: FileText,
  spreadsheet: FileSpreadsheet,
  image: FileImage,
  video: FileVideo2,
  audio: FileMusic,
  archive: FileArchive,
  code: FileCode,
};

export const categoryIcon = (category: string): LucideIcon => CATEGORY_ICON[category] ?? File;
