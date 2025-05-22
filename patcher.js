const asar = require('@electron/asar');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CONFIG = {
    ASAR_PATH: process.env.YAMUSIC_ASAR_PATH || path.join(process.env.LOCALAPPDATA, 'Programs', 'YandexMusic', 'resources', 'app.asar'),
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
    const targetAsarPath = CONFIG.ASAR_PATH;

    try {
        console.log('🔹Начало модификации Яндекс.Музыки');

        if (!fs.existsSync(targetAsarPath)) {
            throw new Error(`Файл ${targetAsarPath} не найден.`);
        }

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

        console.log(`📦 Распаковка ${targetAsarPath} в ${CONFIG.OUTPUT_DIR}...`);
        asar.extractAll(targetAsarPath, CONFIG.OUTPUT_DIR);
        console.log('✅ app.asar успешно распакован');

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
            let pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const deprecatedPackages = ['@yandex-chats/signer', 'yandex-music-unofficial'];
            deprecatedPackages.forEach(pkgName => {
                if (pkg.dependencies?.[pkgName]) { delete pkg.dependencies[pkgName]; }
                if (pkg.devDependencies?.[pkgName]) { delete pkg.devDependencies[pkgName]; }
                if (pkg.optionalDependencies?.[pkgName]) { delete pkg.optionalDependencies[pkgName]; }
            });
            pkg.dependencies = pkg.dependencies || {};
            pkg.dependencies['discord-rpc'] = '^3.2.0';
            fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
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
    rpc.setActivity(activity).catch(console.error);
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
            currentTrack = newData;
            updatePresence();
        }
    };
    setInterval(checkTrack, 3000);
    setTimeout(checkTrack, 500);
}

rpc.on('ready', () => {
    updatePresence();
    trackListener();
});

rpc.login({ clientId: '${CONFIG.DISCORD_CLIENT_ID}' }).catch(console.error);
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

        process.chdir(originalCwd);
        originalCwd = null;
        
        if (fs.existsSync(targetAsarPath)) {
            try {
                fs.unlinkSync(targetAsarPath);
            } catch (unlinkError) {
                console.warn(`⚠️ Ошибка при удалении старого ${targetAsarPath}: ${unlinkError.message}.`);
            }
        }
        
        console.log(`📦 Упаковка модифицированной директории ${CONFIG.OUTPUT_DIR} в ${targetAsarPath}...`);
        await asar.createPackage(CONFIG.OUTPUT_DIR, targetAsarPath);
        console.log('✅ Патченный app.asar успешно создан (перезаписан).');

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
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
