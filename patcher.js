const asar = require('@electron/asar');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CONFIG = {
    ASAR_PATH: process.env.YAMUSIC_ASAR_PATH || path.join(process.env.LOCALAPPDATA, 'Programs', 'YandexMusic', 'resources', 'app.asar'),
    OUTPUT_DIR: path.join(__dirname, 'unpasar'),
    DISCORD_CLIENT_ID: '1373226184820916265',
    MEDIA_FILES_TO_REPLACE: [
        { filename: 'splash_screen_dark.mp4', required: false },
        { filename: 'splash_screen_dark.webm', required: false }
    ],
    MEDIA_TARGET_PATH_IN_ASAR: ['app', 'media'],
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
    const currentAsarPath = CONFIG.ASAR_PATH;
    const trueOriginalBackupPath = currentAsarPath + '.original.backup';
    const prevVersionBackupPath = currentAsarPath + '.prev.backup';

    try {
        console.log('🔹Начало модификации Яндекс.Музыки');

        if (fs.existsSync(currentAsarPath)) {
            if (!fs.existsSync(trueOriginalBackupPath)) {
                fs.copyFileSync(currentAsarPath, trueOriginalBackupPath);
            }
        } else {
            throw new Error(`Файл ${currentAsarPath} не найден.`);
        }

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

        asar.extractAll(currentAsarPath, CONFIG.OUTPUT_DIR);

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
            console.warn(`⚠️Файл package.json не найден в ${CONFIG.OUTPUT_DIR}.`);
        }

        fs.writeFileSync('.npmrc', 'optional=true\nfund=false\naudit=false\nlegacy-peer-deps=true\n');
        try {
            execSync('npm install --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
        } catch (e) {
            execSync('npm install discord-rpc@3.2.0 --no-save --no-audit --no-fund --loglevel=error', { stdio: 'inherit' });
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

rpc.login({ clientId: '${CONFIG.DISCORD_CLIENT_ID}' }).catch(err => {
    console.error('[RPC] Не удалось подключиться к Discord:', err);
});
`;
            let content = fs.readFileSync(preloadPath, 'utf8');
            const insertionPoint = content.lastIndexOf('}');
            if (insertionPoint > -1) {
                content = content.substring(0, insertionPoint) + rpcCode + '\n' + content.substring(insertionPoint);
                 fs.writeFileSync(preloadPath, content);
            } else {
                console.warn('⚠️Не удалось найти подходящее место для вставки RPC кода в preload.js');
            }
        } else {
            console.warn(`⚠️Файл preload.js не найден по пути: ${preloadPath}`);
        }

        const mediaSourceDir = __dirname;
        const mediaTargetDirRelativeInAsar = path.join(...CONFIG.MEDIA_TARGET_PATH_IN_ASAR);

        if (!fs.existsSync(mediaTargetDirRelativeInAsar)) {
            try {
                fs.mkdirSync(mediaTargetDirRelativeInAsar, { recursive: true });
            } catch (mkdirError) {
                 console.error(`❌Ошибка при создании директории ${mediaTargetDirRelativeInAsar}: ${mkdirError.message}.`);
            }
        }

        if (fs.existsSync(mediaTargetDirRelativeInAsar)) {
            CONFIG.MEDIA_FILES_TO_REPLACE.forEach(mediaFile => {
                const sourceFilePath = path.join(mediaSourceDir, mediaFile.filename);
                const targetFilePathRelativeInAsar = path.join(mediaTargetDirRelativeInAsar, mediaFile.filename);
                if (fs.existsSync(targetFilePathRelativeInAsar)) {
                    try {
                        fs.unlinkSync(targetFilePathRelativeInAsar);
                    } catch (unlinkError) {
                        console.warn(`⚠️Ошибка при удалении существующего файла ${targetFilePathRelativeInAsar}: ${unlinkError.message}.`);
                    }
                }
                if (fs.existsSync(sourceFilePath)) {
                    try {
                        fs.copyFileSync(sourceFilePath, targetFilePathRelativeInAsar);
                    } catch (copyError) {
                        console.warn(`⚠️Ошибка при копировании ${mediaFile.filename}: ${copyError.message}`);
                    }
                } else {
                    if (mediaFile.required) {
                        console.error(`Исходный файл ${sourceFilePath} не найден. (Файл обязателен!)`);
                    }
                }
            });
        }

        process.chdir(originalCwd);
        originalCwd = null;

        if (fs.existsSync(currentAsarPath)) {
            try {
                fs.renameSync(currentAsarPath, prevVersionBackupPath);
            } catch (renameError) {
                console.error(`❌Ошибка при переименовании ${currentAsarPath}: ${renameError.message}`);
                throw new Error(`Не удалось создать бэкап предыдущей версии.`);
            }
        }
        
        await asar.createPackage(CONFIG.OUTPUT_DIR, currentAsarPath);

        if (fs.existsSync(CONFIG.OUTPUT_DIR)) {
            fs.rmSync(CONFIG.OUTPUT_DIR, { recursive: true, force: true });
        }
    } catch (err) {
        console.error('❌Ошибка при модификации:', err.message);
        if (originalCwd && process.cwd() !== originalCwd) {
            process.chdir(originalCwd);
        }
        process.exit(1);
    }
}

patchApp();
