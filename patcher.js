const asar = require('@electron/asar');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CONFIG = {
    OUTPUT_DIR: path.join(__dirname, 'unpasar'),
    DISCORD_CLIENT_ID: '1373226184820916265',
    SELECTORS: {
        CURRENT: {
            TITLE: '.Meta_title__GGBnH',
            ARTIST: '.Meta_artistCaption__JESZi'
        },
        FALLBACK: [
            {
                TITLE: '.d-track__title',
                ARTIST: '.d-track__artists'
            },
            {
                TITLE: '.track__title',
                ARTIST: '.track__artists'
            }
        ]
    }
};

async function patchApp() {
    let originalCwd;
    const sourceAsarPath = process.env.YAMUSIC_SOURCE_ASAR_PATH;
    const patchedAsarOutputPath = process.env.YAMUSIC_PATCHED_ASAR_OUTPUT_PATH;
    const patchVersion = process.env.YAMUSIC_PATCH_VERSION;
    const githubReleasesUrl = process.env.GITHUB_RELEASES_URL;
    const githubReleasesDownloadUrlBase = process.env.GITHUB_RELEASES_DOWNLOAD_URL_BASE;

    if (!sourceAsarPath || !patchedAsarOutputPath || !patchVersion || !githubReleasesUrl || !githubReleasesDownloadUrlBase) {
        console.error('❌ Отсутствуют необходимые переменные окружения!');
        process.exit(1);
    }

    const tempSourceAsarPath = path.join(__dirname, 'source_app.asar');

    try {
        console.log('🔹Начало модификации Яндекс.Музыки');

        if (!fs.existsSync(sourceAsarPath)) {
            throw new Error(`Исходный файл ${sourceAsarPath} не найден.`);
        }

        console.log(`Копирование ${sourceAsarPath} в ${tempSourceAsarPath}...`);
        fs.copyFileSync(sourceAsarPath, tempSourceAsarPath);
        console.log('✅ Исходный app.asar скопирован.');

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

        console.log(`📦 Распаковка ${tempSourceAsarPath} в ${CONFIG.OUTPUT_DIR}...`);
        asar.extractAll(tempSourceAsarPath, CONFIG.OUTPUT_DIR);
        console.log('✅ Временный app.asar успешно распакован');

        originalCwd = process.cwd();
        process.chdir(CONFIG.OUTPUT_DIR);

        if (fs.existsSync('package-lock.json')) {
            fs.unlinkSync('package-lock.json');
        }
        if (fs.existsSync('yarn.lock')) {
            fs.unlinkSync('yarn.lock');
        }

        const packageJsonPath = 'package.json';
        if (fs.existsSync(packageJsonPath)) {
            console.log('🛠️ Модификация package.json...');
            let pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

            const deprecatedPackages = ['@yandex-chats/signer', 'yandex-music-unofficial', 'electron'];
            deprecatedPackages.forEach(pkgName => {
                if (pkg.dependencies?.[pkgName]) { delete pkg.dependencies[pkgName]; }
                if (pkg.devDependencies?.[pkgName]) { delete pkg.devDependencies[pkgName]; }
                if (pkg.optionalDependencies?.[pkgName]) { delete pkg.optionalDependencies[pkgName]; }
            });
            pkg.dependencies = pkg.dependencies || {};
            pkg.dependencies['discord-rpc'] = '^3.2.0';

            pkg.version = patchVersion;
            if (pkg.buildInfo) {
                pkg.buildInfo.VERSION = patchVersion;
            }
            if (pkg.common) {
                pkg.common.UPDATE_URL = githubReleasesUrl;
            }

            fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
            console.log('✅ package.json успешно модифицирован');
        } else {
            console.warn(`⚠️ Файл package.json не найден в ${CONFIG.OUTPUT_DIR}.`);
        }

        fs.writeFileSync('.npmrc', 'optional=true\nfund=false\naudit=false\nlegacy-peer-deps=true\n');
        console.log('📦 Устанавливаем зависимости (включая discord-rpc)...');
        try {
            execSync('npm install --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
            console.log('✅ Зависимости успешно установлены.');
        } catch (e) {
            console.warn('⚠ Ошибка установки, пробуем установить только discord-rpc...');
            try {
                execSync('npm install discord-rpc@3.2.0 --no-save --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
                console.log('✅ discord-rpc установлен альтернативным методом.');
            } catch (finalError) {
                throw finalError;
            }
        }

        const preloadPath = path.join('main', 'lib', 'preload.js');
        if (fs.existsSync(preloadPath)) {
            const rpcCode = `
// ======== Discord RPC Integration ========
const { Client } = require('discord-rpc');
const rpc = new Client({ transport: 'ipc' });
let currentTrack = {};

const SELECTORS = ${JSON.stringify(CONFIG.SELECTORS, null, 4)};

function updatePresence() {
    if (!rpc) return;
    const activity = {
        details: currentTrack.title || 'Слушает музыку',
        state: currentTrack.artist || 'Яндекс.Музыка',
        largeImageKey: 'yandex_music_logo',
        largeImageText: 'Яндекс.Музыка',
        buttons: [{
            label: 'Слушать трек',
            url: window.location.href && window.location.href !== 'about:blank' ? window.location.href : 'https://music.yandex.ru'
        }]
    };
    if (currentTrack.title) {
        activity.startTimestamp = Math.floor(Date.now() / 1000) - (currentTrack.elapsed || 0);
    }
    rpc.setActivity(activity).catch(err => console.error('[RPC] Ошибка установки активности:', err));
}

function trackListener() {
    const getTrackInfo = () => {
        let titleElem, artistElem;
        titleElem = document.querySelector(SELECTORS.CURRENT.TITLE);
        artistElem = document.querySelector(SELECTORS.CURRENT.ARTIST);
        if (!titleElem || !artistElem) {
            for (const fallback of SELECTORS.FALLBACK) {
                titleElem = document.querySelector(fallback.TITLE);
                artistElem = document.querySelector(fallback.ARTIST);
                if (titleElem && artistElem) break;
            }
        }
        return { 
            title: titleElem?.textContent?.trim(),
            artist: artistElem?.textContent?.trim()
        };
    };

    const checkTrack = () => {
        const newData = getTrackInfo();
        if (newData.title !== currentTrack.title || newData.artist !== currentTrack.artist) {
            console.log('[RPC] Трек изменился:', newData);
            currentTrack = newData;
            updatePresence();
        }
    };

    setInterval(checkTrack, 3000);
    setTimeout(checkTrack, 500);
}

rpc.on('ready', () => {
    console.log('[RPC] Discord Rich Presence подключен для клиента ID: ${CONFIG.DISCORD_CLIENT_ID}');
    updatePresence();
    trackListener();
});

rpc.login({ clientId: '${CONFIG.DISCORD_CLIENT_ID}' }).catch(err => {
    console.error('[RPC] Не удалось подключиться к Discord:', err);
});
// ======== Конец интеграции RPC ========
`;
            let content = fs.readFileSync(preloadPath, 'utf8');
            const insertionPoint = content.lastIndexOf('}');
            if (insertionPoint > -1) {
                content = content.substring(0, insertionPoint) + rpcCode + '\n' + content.substring(insertionPoint);
                 fs.writeFileSync(preloadPath, content);
            } else {
                console.warn('⚠️ Не удалось найти подходящее место для вставки RPC кода в preload.js');
            }
        } else {
            console.warn(`⚠️ Файл preload.js не найден по пути: ${preloadPath}`);
        }

        const loadReleaseNotesPath = path.join('main', 'lib', 'loadReleaseNotes.js');
        if (fs.existsSync(loadReleaseNotesPath)) {
            console.log('🛠️ Модификация loadReleaseNotes.js...');
            let content = fs.readFileSync(loadReleaseNotesPath, 'utf8');
            content = content.replace(/(const url = `\$\{(config_1|config)\.config\.common\.UPDATE_URL\}release-notes\/\$\{\w+\}\.json`;)/g, `const url = \`${githubReleasesDownloadUrlBase}/${patchVersion}/ru.json\`;`);
            
            fs.writeFileSync(loadReleaseNotesPath, content);
            console.log('✅ loadReleaseNotes.js успешно модифицирован.');
        } else {
            console.warn(`⚠️ Файл loadReleaseNotes.js не найден по пути: ${loadReleaseNotesPath}`);
        }

        process.chdir(originalCwd);
        originalCwd = null;
        
        console.log(`📦 Упаковка модифицированной директории ${CONFIG.OUTPUT_DIR} в ${patchedAsarOutputPath}...`);
        await asar.createPackage(CONFIG.OUTPUT_DIR, patchedAsarOutputPath);
        console.log(`✅ Патченный app.asar успешно создан в ${patchedAsarOutputPath}.`);

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
        }
        if (fs.existsSync(tempSourceAsarPath)) {
            fs.unlinkSync(tempSourceAsarPath);
        }

        console.log('\n✨ Модификация и перепаковка Яндекс.Музыки завершена успешно!');

    } catch (err) {
        console.error('❌ Ошибка при модификации:', err.message);
        if (err.stack) {
            console.error(err.stack);
        }
        if (err.stderr && typeof err.stderr.toString === 'function') {
            console.error('Stderr:', err.stderr.toString());
        }
        
        if (originalCwd && process.cwd() !== originalCwd) {
            process.chdir(originalCwd);
        }
        process.exit(1);
    }
}

patchApp();
