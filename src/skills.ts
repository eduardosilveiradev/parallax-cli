import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SkillSummary {
  name: string;
  frontmatter: string;
  filePath: string;
}

export function loadWorkspaceSkills(cwd: string): SkillSummary[] {
  const skills: SkillSummary[] = [];
  const searchPaths = [
    path.join(cwd, '.agents'),
    path.join(cwd, '.agent'),
    path.join(cwd, '_agents'),
    path.join(cwd, '_agent'),
    path.join(os.homedir(), '.agents'),
    path.join(os.homedir(), '.agent')
  ];

  for (const fullPath of searchPaths) {
    if (!fs.existsSync(fullPath)) continue;

    const findSkills = (currentPath: string) => {
      let entries;
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          findSkills(path.join(currentPath, entry.name));
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          const filePath = path.join(currentPath, entry.name);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (match) {
              const frontmatter = match[0]; // Include the --- tags
              const inner = match[1];
              const nameMatch = inner.match(/^name:\s*(.+)$/m);
              const name = nameMatch ? nameMatch[1].trim() : path.basename(path.dirname(filePath));
              skills.push({ name, frontmatter, filePath });
            } else {
              skills.push({ name: path.basename(path.dirname(filePath)), frontmatter: 'No frontmatter description available', filePath });
            }
          } catch (e) {
            // Ignore unreadable files
          }
        }
      }
    };

    findSkills(fullPath);
  }

  return skills;
}
