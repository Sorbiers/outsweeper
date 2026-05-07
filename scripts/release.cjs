const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const STATIC_SRC = path.join(ROOT, 'static');
const STATIC_DEST = path.join(RELEASE, 'static');

function clean() {
  if (fs.existsSync(RELEASE)) {
    fs.rmSync(RELEASE, { recursive: true });
  }
  fs.mkdirSync(RELEASE, { recursive: true });
}

function buildFrontend() {
  console.log('Building Angular frontend...');
  execSync('npx ng build', { cwd: path.join(ROOT, 'frontend'), stdio: 'inherit' });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function assembleRelease() {
  console.log('Assembling release...');

  fs.copyFileSync(path.join(ROOT, 'app.py'), path.join(RELEASE, 'app.py'));
  fs.copyFileSync(path.join(ROOT, 'requirements.txt'), path.join(RELEASE, 'requirements.txt'));

  copyDir(STATIC_SRC, STATIC_DEST);

  fs.writeFileSync(path.join(RELEASE, 'run.bat'),
    '@echo off\r\n' +
    'if "%~1"=="" (\r\n' +
    '  echo Usage: run.bat ^<source_folder^>\r\n' +
    '  exit /b 1\r\n' +
    ')\r\n' +
    'python app.py %*\r\n'
  );

  fs.writeFileSync(path.join(RELEASE, 'install_deps.bat'),
    '@echo off\r\n' +
    'pip install -r requirements.txt\r\n'
  );
}

function main() {
  clean();
  buildFrontend();
  assembleRelease();

  const files = fs.readdirSync(RELEASE);
  console.log(`\nRelease built -> ${RELEASE}`);
  console.log(`Contents: ${files.join(', ')}`);
  console.log('\nTo use:');
  console.log('  1. cd release');
  console.log('  2. install_deps.bat   (first time only)');
  console.log('  3. run.bat <photo_folder>');
}

main();
