import fs from 'fs';
import fetch from 'node-fetch';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error('Ошибка: Переменная окружения GITHUB_TOKEN не установлена.');
    process.exit(1);
}

const TARGET_EXAMPLES = 1000;
const OUTPUT_FILE = 'data.jsonl';
const REQUESTS_PER_MINUTE = 10;
const MS_BETWEEN_REQUESTS = (60 * 1000) / REQUESTS_PER_MINUTE;

const REFORMAT_KEYWORDS = [
    'refactor', 'refactoring', 'cleanup', 'simplify', 'restructure', 'extract method', 'extract function',
    'перепис', 'упрощ', 'чистка кода', 'оптимиз', 'архитектур',
    'chore: refactor', 'feat: refactor', 'fix: refactor'
];

let collectedExamples = 0;
let processedRepos = new Set();

if (fs.existsSync(OUTPUT_FILE)) {
    const existingLines = fs.readFileSync(OUTPUT_FILE, 'utf8').trim().split('\n').filter(l => l.length > 0);
    collectedExamples = existingLines.length;
    console.log(`Найдено существующих примеров: ${collectedExamples}. Продолжаем сбор...`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function printProgress() {
    readline.cursorTo(process.stdout, 0);
    process.stdout.clearLine(1);
    process.stdout.write(`Собрано: ${collectedExamples}/${TARGET_EXAMPLES}`);
}

export async function fetchFileFromCommit(repo, sha, path) {
    const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${sha}`;
    try {
        const res = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.content) {
            return Buffer.from(data.content, 'base64').toString('utf8');
        }
        return null;
    } catch (e) {
        return null;
    }
}

export async function fetchFileFromMain(repo, path) {
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    try {
        const res = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.content) {
            return Buffer.from(data.content, 'base64').toString('utf8');
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function collectRefactoringExamples() {
    const outputStream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });

    const reposToProcess = [
        'facebook/react', 'vuejs/core', 'angular/angular', 'sveltejs/svelte', 'vercel/next.js',
        'axios/axios', 'mui/material-ui', 'lodash/lodash', 'expressjs/express', 'nestjs/nest',
        'prisma/prisma', 'strapi/strapi', 'nuxt/nuxt', 'remix-run/remix', 'tanstack/query',
        'babel/babel', 'webpack/webpack', 'rollup/rollup', 'typescript/typescript', 'nodejs/node',
        'storybookjs/storybook', 'testing-library/react-testing-library', 'date-fns/date-fns',
        'chartjs/Chart.js', 'threejs/three.js', 'socketio/socket.io', 'meteor/meteor',
        'appwrite/appwrite', 'directus/directus', 'keystonejs/keystone', 'redwoodjs/redwood',
        'gatsbyjs/gatsby', 'gridsome/gridsome', 'quasarframework/quasar', 'tauri-apps/tauri'
    ];

    console.log('Этап 1: Проход по репозиториям...');

    for (const repoFullName of reposToProcess) {
        if (collectedExamples >= TARGET_EXAMPLES) break;
        if (processedRepos.has(repoFullName)) continue;

        processedRepos.add(repoFullName);
        console.log(`\nОбрабатываем: ${repoFullName}`);

        try {
            const commitsUrl = `https://api.github.com/repos/${repoFullName}/commits?per_page=100`;
            const res = await fetch(commitsUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
            if (!res.ok) continue;

            const commits = await res.json();

            for (const commit of commits) {
                if (collectedExamples >= TARGET_EXAMPLES) break;

                if (!commit.commit || !commit.commit.message) continue;

                const message = commit.commit.message.toLowerCase();
                if (!REFORMAT_KEYWORDS.some(k => message.includes(k))) continue;

                console.log(`  -> Найден коммит: ${commit.sha.substring(0, 7)}`);

                await sleep(MS_BETWEEN_REQUESTS);

                const commitDetailRes = await fetch(commit.url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
                if (!commitDetailRes.ok) continue;

                const commitDetail = await commitDetailRes.json();

                const files = commitDetail.files?.filter(f =>
                    /\.(js|jsx)$/i.test(f.filename) &&

                    (
                        f.filename.includes('/input/') ||
                        f.filename.startsWith('src/') ||
                        f.filename.startsWith('packages/') ||
                        f.filename.startsWith('lib/')
                    ) &&
                    !f.filename.includes('/third_party/') &&
                    !f.filename.includes('/node_modules/') && // На всякий случай

                    !f.filename.includes('/output/') &&
                    !f.filename.includes('__snapshots__')
                );

                if (!files || files.length === 0) continue;

                console.log(`  -> Найдено ${files.length} валидных файлов`);

                for (const file of files) {
                    if (collectedExamples >= TARGET_EXAMPLES) break;

                    console.log(`    -> Сборка примера для: ${file.filename}`);

                    const afterCode = await fetchFileFromMain(repoFullName, file.filename);
                    const beforeCode = await fetchFileFromCommit(repoFullName, commit.sha, file.filename);

                    if (!beforeCode || !afterCode) continue;

                    const example = {
                        before: beforeCode,
                        after: afterCode,
                        source: {
                            repo: repoFullName,
                            sha: commit.sha,
                            url: commit.html_url,
                            message: commit.commit.message,
                            file: file.filename
                        }
                    };

                    outputStream.write(JSON.stringify(example) + '\n');
                    collectedExamples++;
                    printProgress();
                }
            }
        } catch (error) {
            console.error(`Ошибка при обработке ${repoFullName}:`, error.message);
            await sleep(MS_BETWEEN_REQUESTS * 5);
        }
    }

    outputStream.close();
    console.log(`\n\nГотово! Собрано ${collectedExamples} примеров в ${OUTPUT_FILE}`);
}

collectRefactoringExamples();