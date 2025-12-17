// bundle.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 합칠 파일 확장자들
const extensions = ['.ts', '.tsx', '.css', '.json', '.html'];
// 제외할 폴더 및 파일
const ignore = ['node_modules', 'dist', 'build', '.git', 'package-lock.json', 'bundle.js', 'stats.html'];

let output = '';

function scanDirectory(dir) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (ignore.includes(file)) continue;

        if (stat.isDirectory()) {
            scanDirectory(fullPath);
        } else {
            const ext = path.extname(file);
            if (extensions.includes(ext)) {
                const content = fs.readFileSync(fullPath, 'utf8');
                // AI가 파일 위치를 알 수 있도록 헤더 추가
                output += `\n\n--- START OF FILE: ${fullPath.replace(__dirname, '')} ---\n`;
                output += content;
                output += `\n--- END OF FILE ---\n`;
            }
        }
    }
}

console.log('📦 프로젝트 파일들을 하나로 묶는 중...');
scanDirectory(__dirname);

fs.writeFileSync('project_context.txt', output);
console.log('✅ 완료! "project_context.txt" 파일이 생성되었습니다.');
console.log('👉 이 파일을 Google AI Studio에 업로드하세요.');