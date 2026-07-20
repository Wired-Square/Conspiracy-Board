#!/usr/bin/env node
// Create a release: bump version, commit, tag, and push
//
// Usage:
//   node release.js           # patch release: 0.2.10 → 0.2.11
//   node release.js patch     # patch release: 0.2.10 → 0.2.11
//   node release.js minor     # minor release: 0.2.10 → 0.3.0
//   node release.js major     # major release: 0.2.10 → 1.0.0
//   node release.js rebuild   # re-release current version (fix build errors)

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Parse bump type from args (default: patch)
// Special mode: "rebuild" re-releases the current version without bumping
const bumpType = process.argv[2] || 'patch';
const isRebuild = bumpType === 'rebuild';
if (!isRebuild && !['major', 'minor', 'patch'].includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}`);
  console.error('Usage: node release.js [major|minor|patch|rebuild]');
  console.error('  rebuild  Re-release current version (no version bump)');
  process.exit(1);
}

function run(cmd, options = {}) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { cwd: rootDir, stdio: 'inherit', ...options });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function runSilent(cmd) {
  return execSync(cmd, { cwd: rootDir, encoding: 'utf8' }).trim();
}

async function askUser(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

/**
 * Calculate the new version based on current version and bump type
 */
function calculateNewVersion(currentVersion, bumpType) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function main() {
  // Check for uncommitted changes (rebuild is allowed to commit build fixes)
  const status = runSilent('git status --porcelain');
  const uncommittedFiles = status.split('\n').filter(line => line.trim());

  if (uncommittedFiles.length > 0 && !isRebuild) {
    console.error('Error: Working directory has uncommitted changes.');
    console.error('Please commit or stash your changes before releasing.');
    console.error('Uncommitted files:');
    uncommittedFiles.forEach(line => console.error(`  ${line}`));
    process.exit(1);
  }

  const hasUncommittedChanges = uncommittedFiles.length > 0;

  // Check we're on main branch
  const branch = runSilent('git branch --show-current');
  if (branch !== 'main') {
    console.error(`Error: Releases should be made from 'main' branch (currently on '${branch}').`);
    process.exit(1);
  }

  // Calculate what the new version will be
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const currentVersion = packageJson.version;
  const newVersion = isRebuild ? currentVersion : calculateNewVersion(currentVersion, bumpType);
  const tag = `v${newVersion}`;

  if (isRebuild) {
    console.log(`\nPreparing rebuild release: v${currentVersion} (no version bump)\n`);

    // Check that the tag already exists (we're replacing it)
    const existingTags = runSilent('git tag --list');
    if (!existingTags.split('\n').includes(tag)) {
      console.error(`Error: Tag ${tag} does not exist. Use a normal release for new versions.`);
      process.exit(1);
    }
  } else {
    console.log(`\nPreparing ${bumpType} release: ${currentVersion} → ${newVersion}\n`);
  }

  // Ask for user confirmation
  const confirmMsg = isRebuild
    ? `Proceed with rebuild release v${newVersion}? This will delete and recreate the tag. [y/N] `
    : `Proceed with release v${newVersion}? [y/N] `;
  const answer = await askUser(confirmMsg);
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Release cancelled.');
    process.exit(0);
  }

  // Pull latest changes
  console.log('\nPulling latest changes...');
  run('git pull --rebase');

  if (isRebuild) {
    // Rebuild: commit fixes if any, move existing tag, force-push
    if (hasUncommittedChanges) {
      console.log('\nCommitting fixes...');
      run('git add -A');
      run(`git commit -m "Fix build for v${newVersion}"`);
    } else {
      console.log('\nNo uncommitted changes — moving tag only.');
    }

    // Delete the old tag locally and remotely, then recreate
    console.log(`\nMoving tag ${tag} to current commit...`);
    run(`git tag -d ${tag}`);
    run(`git push origin :refs/tags/${tag}`);
    run(`git tag ${tag}`);
  } else {
    // Normal release: bump version, commit, create tag
    console.log(`\nBumping ${bumpType} version...`);
    run(`node scripts/bump-version.js ${bumpType}`);

    // Update Cargo.lock by running cargo check
    console.log('\nUpdating Cargo.lock...');
    run('cargo check --manifest-path src-tauri/Cargo.toml');

    console.log('\nCommitting version bump...');
    run('git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json');
    run(`git commit -m "Bump version to ${newVersion}"`);

    // Create tag
    console.log(`\nCreating tag ${tag}...`);
    run(`git tag ${tag}`);
  }

  // Push commit and tag
  console.log('\nPushing to remote...');
  run('git push origin main --tags');

  console.log(`
✅ Release ${tag} created successfully!

GitHub Actions will now:
1. Build the macOS app
2. Create a draft release with the installer

Next steps:
1. Go to https://github.com/Wired-Square/Conspiracy-Board/releases
2. Review the draft release
3. Edit release notes if needed
4. Publish the release
`);
}

main().catch((error) => {
  console.error('Release failed:', error);
  process.exit(1);
});
