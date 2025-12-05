// 从Telegram同步所有图片到数据库的API端点
const https = require('https');
const { addImage, getImageByFileId, updateImage, getAllTelegramImages, deleteTelegramImagesNotInList, getImages, getStats, getLastUpdateId, setLastUpdateId } = require('./kv-database');
const { verifyAdminToken } = require('./auth-middleware');

// 从环境变量获取配置
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 验证环境变量
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_bot_token_here') {
    console.error('错误: TELEGRAM_BOT_TOKEN 环境变量未设置或使用了占位符值');
}

if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'your_chat_id_here') {
    console.error('错误: TELEGRAM_CHAT_ID 环境变量未设置或使用了占位符值');
}

// 检查同步状态功能
async function checkSyncStatus() {
    console.log('检查同步状态...');
    
    // 获取数据库统计信息
    const stats = await getStats();
    console.log(`数据库中共有 ${stats.totalImages} 张图片`);
    
    // 获取所有Telegram图片
    const telegramImages = await getAllTelegramImages();
    console.log(`数据库中有 ${telegramImages.length} 张Telegram图片`);
    
    // 获取最新的20张图片（不限来源）
    const recentImages = await getImages(1, 20);
    console.log(`获取到 ${recentImages.images.length} 张最新图片`);
    
    // 分析图片来源
    const sourceAnalysis = {
        total: recentImages.images.length,
        telegram: 0,
        upload: 0,
        unknown: 0
    };
    
    const imageDetails = recentImages.images.map(img => {
        const isTelegram = !!img.fileId;
        if (isTelegram) {
            sourceAnalysis.telegram++;
        } else if (img.uploadPath) {
            sourceAnalysis.upload++;
        } else {
            sourceAnalysis.unknown++;
        }
        
        return {
            id: img.id,
            filename: img.filename,
            fileId: img.fileId || 'N/A',
            category: img.category || 'N/A',
            source: isTelegram ? 'Telegram' : (img.uploadPath ? 'Upload' : 'Unknown'),
            createdAt: new Date(img.createdAt).toISOString()
        };
    });
    
    // 检查数据库中所有图片的结构（前50张）
    const moreImages = await getImages(1, 50);
    let withFileId = 0;
    let withoutFileId = 0;
    
    for (const img of moreImages.images) {
        if (img.fileId) {
            withFileId++;
        } else {
            withoutFileId++;
        }
    }
    
    // 返回详细状态
    return {
        success: true,
        message: '同步状态检查完成',
        stats: {
            totalImages: stats.totalImages,
            telegramImages: telegramImages.length,
            withFileId,
            withoutFileId
        },
        sourceAnalysis,
        recentImages: imageDetails,
        telegramImageDetails: telegramImages.map(img => ({
            id: img.id,
            fileId: img.fileId,
            category: img.category
        })),
        // 添加诊断信息
        diagnosis: {
            telegramImagesInDb: telegramImages.length,
            telegramImagesInDbDetails: telegramImages,
            potentialIssue: telegramImages.length > 0 ? "数据库中有Telegram图片，但可能未被正确删除" : "数据库中没有Telegram图片"
        }
    };
}

module.exports = async (req, res) => {
    // 设置CORS头
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // 只接受GET和POST请求
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    // 检查是否是检查同步状态的请求
    if (req.method === 'GET' && req.url && req.url.includes('action=status')) {
        try {
            const statusResult = await checkSyncStatus();
            return res.status(200).json(statusResult);
        } catch (error) {
            console.error('检查同步状态时发生错误:', error);
            return res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
    }
    
    // 验证管理员权限（对于同步操作）
    const authResult = verifyAdminToken(req);
    if (!authResult.valid) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // 验证环境变量
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_bot_token_here') {
        return res.status(500).json({ 
            error: 'Configuration error', 
            message: 'TELEGRAM_BOT_TOKEN 环境变量未设置或使用了占位符值。请在部署环境中设置正确的Bot Token。' 
        });
    }
    
    if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'your_chat_id_here') {
        return res.status(500).json({ 
            error: 'Configuration error', 
            message: 'TELEGRAM_CHAT_ID 环境变量未设置或使用了占位符值。请在部署环境中设置正确的Chat ID。' 
        });
    }
    
    try {
        console.log('开始从Telegram同步图片...');
        console.log('新图片将保存到根目录，已存在的图片将保留在原文件夹中');
        console.log(`使用Bot Token: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}...`);
        console.log(`目标频道ID: ${TELEGRAM_CHAT_ID}`);
        
        // 检查是否是频道（频道ID通常是负数或以@开头）
        const isChannel = TELEGRAM_CHAT_ID.startsWith('-') || TELEGRAM_CHAT_ID.startsWith('@');
        
        let profilePhotos = [];
        let chatPhotos = [];
        
        if (isChannel) {
            console.log('检测到频道ID，跳过获取个人资料照片');
        } else {
            // 获取用户个人资料照片
            console.log('正在获取用户个人资料照片...');
            profilePhotos = await getUserProfilePhotos();
            console.log(`找到 ${profilePhotos.length} 张个人资料照片`);
        }
        
        // 获取聊天消息中的图片
        console.log('正在获取聊天消息中的图片...');
        chatPhotos = await getChatPhotos();
        console.log(`找到 ${chatPhotos.length} 张聊天消息中的图片`);
        
        // 合并所有图片
        const allPhotos = [...profilePhotos, ...chatPhotos];
        console.log(`总共找到 ${allPhotos.length} 张图片`);
        
        // 打印所有找到的图片的file_id，用于调试
        if (allPhotos.length > 0) {
            console.log('找到的图片file_id列表:');
            allPhotos.forEach((photo, index) => {
                console.log(`  ${index + 1}. ${photo.file_id} (${photo.type})`);
            });
        } else {
            console.log('警告：没有找到任何图片，这可能是Telegram API访问问题');
        }
        
        // 同步到数据库
        const syncResult = await syncPhotosToDatabase(allPhotos);
        const syncedCount = syncResult.syncedCount;
        const updatedCount = syncResult.updatedCount;
        const skippedCount = syncResult.skippedCount;
        const deletedCount = syncResult.deletedCount;
        
        return res.status(200).json({
            success: true,
            message: `同步完成，新增 ${syncedCount} 张图片到根目录，跳过 ${skippedCount} 张已存在的图片，删除 ${deletedCount} 张已不存在的图片`,
            syncedCount,
            updatedCount,
            skippedCount,
            deletedCount,
            totalPhotos: allPhotos.length,
            profilePhotosCount: profilePhotos.length,
            chatPhotosCount: chatPhotos.length,
            targetFolderId: null, // 明确表示所有新图片都保存到根目录
            forceRefresh: true // 添加此标志，告诉前端需要强制刷新缓存
        });
    } catch (error) {
        console.error('同步Telegram图片时出错:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

// 同步图片到数据库
async function syncPhotosToDatabase(photos) {
    let syncedCount = 0;
    let skippedCount = 0;
    let deletedCount = 0;
    
    console.log(`开始同步 ${photos.length} 张图片到数据库...`);
    console.log('新同步策略：删除Telegram中已不存在的图片，保留已存在图片的分类信息');
    
    try {
        // 1. 同步前状态检查
        console.log('=== 同步前状态检查 ===');
        const stats = await getStats();
        console.log(`数据库中共有 ${stats.totalImages} 张图片`);
        
        // 获取数据库中所有Telegram图片
        const existingTelegramImages = await getAllTelegramImages();
        console.log(`数据库中有 ${existingTelegramImages.length} 张Telegram图片`);
        
        // 打印数据库中找到的Telegram图片，用于调试
        if (existingTelegramImages.length > 0) {
            console.log('数据库中的Telegram图片列表:');
            existingTelegramImages.forEach((img, index) => {
                console.log(`  ${index + 1}. ID: ${img.id}, FileId: ${img.fileId}, Category: ${img.category}`);
            });
        }
        
        // 获取当前Telegram中的所有图片fileId
        const currentFileIds = photos.map(photo => photo.file_id);
        console.log(`当前Telegram中有 ${currentFileIds.length} 张图片`);
        
        // 打印Telegram中的图片，用于调试
        if (photos.length > 0) {
            console.log('Telegram中的图片列表:');
            photos.forEach((photo, index) => {
                console.log(`  ${index + 1}. FileId: ${photo.file_id}, Type: ${photo.type}`);
            });
        }
        
        // 检查是否存在数据不一致的情况
        if (existingTelegramImages.length > 0 && photos.length === 0) {
            console.log('警告：数据库中有Telegram图片但Telegram中没有获取到任何图片');
            console.log('这可能是API访问问题或同步逻辑问题');
        }
        
        if (existingTelegramImages.length === 0 && photos.length > 0) {
            console.log('信息：数据库中没有Telegram图片但Telegram中获取到了图片');
            console.log('这可能是首次同步或之前清空了数据库');
        }
        
        console.log('=== 状态检查完成，开始同步 ===');
        
        // 2. 创建一个映射，存储已存在图片的分类信息
        const existingImageCategories = {};
        for (const img of existingTelegramImages) {
            existingImageCategories[img.fileId] = img.category;
        }
        
        // 3. 删除不在当前Telegram列表中的图片
        if (existingTelegramImages.length > 0) {
            console.log(`开始检查需要删除的图片...`);
            console.log(`当前Telegram图片fileId列表: [${currentFileIds.join(', ')}]`);
            
            deletedCount = await deleteTelegramImagesNotInList(currentFileIds);
            console.log(`删除了 ${deletedCount} 张已不存在的图片`);
        } else {
            console.log('数据库中没有Telegram图片，跳过删除步骤');
        }
        
        // 4. 处理当前Telegram中的图片
        for (const photo of photos) {
            try {
                // 检查图片是否已经存在于数据库中
                console.log(`检查图片是否存在: ${photo.file_id}`);
                const existingImage = await getImageByFileId(photo.file_id);
                console.log(`检查结果: ${existingImage ? '存在' : '不存在'}`);
                
                if (!existingImage) {
                    // 图片不存在，添加到数据库，使用之前保存的分类信息（如果有）
                    const imageInfo = {
                        filename: `telegram_${photo.file_id}`,
                        url: photo.url,
                        size: photo.file_size || photo.fileSize || 0,
                        fileId: photo.file_id, // 确保使用小写的fileId，与上传时保持一致
                        category: existingImageCategories[photo.file_id] || photo.category || 'general',
                        type: photo.type,
                        folderId: null, // 新图片默认保存到根目录
                        metadata: {
                            messageId: photo.messageId,
                            from: photo.from,
                            date: photo.date,
                            caption: photo.caption,
                            fileName: photo.fileName
                        }
                    };
                    
                    await addImage(imageInfo);
                    syncedCount++;
                    console.log(`已同步图片: ${photo.file_id} (${photo.type}) 到数据库，分类: ${imageInfo.category}`);
                } else {
                    // 图片已存在，跳过不更新
                    skippedCount++;
                    console.log(`跳过已存在的图片: ${photo.file_id}`);
                }
            } catch (error) {
                console.error(`同步图片 ${photo.file_id} 时出错:`, error);
            }
        }
        
        // 5. 同步后状态检查
        console.log('=== 同步后状态检查 ===');
        const newStats = await getStats();
        console.log(`同步后数据库中共有 ${newStats.totalImages} 张图片`);
        
        const newTelegramImages = await getAllTelegramImages();
        console.log(`同步后数据库中有 ${newTelegramImages.length} 张Telegram图片`);
        
        console.log(`同步完成，共处理 ${photos.length} 张图片，新增 ${syncedCount} 张，跳过 ${skippedCount} 张，删除 ${deletedCount} 张`);
        
        // 检查同步结果是否符合预期
        if (syncedCount === 0 && skippedCount === photos.length && deletedCount === 0) {
            console.log('信息：所有图片都已存在于数据库中，无需同步');
        } else if (syncedCount > 0) {
            console.log(`信息：成功同步了 ${syncedCount} 张新图片`);
        }
        
        if (deletedCount > 0) {
            console.log(`信息：删除了 ${deletedCount} 张已不存在的图片`);
        }
        
        return { syncedCount, updatedCount: 0, skippedCount, deletedCount };
    } catch (error) {
        console.error('同步过程中发生错误:', error);
        throw error;
    }
}

// 获取用户个人资料照片
async function getUserProfilePhotos() {
    return new Promise((resolve, reject) => {
        try {
            // 检查是否是频道（频道ID通常是负数）
            const isChannel = TELEGRAM_CHAT_ID.startsWith('-');
            
            if (isChannel) {
                console.log('频道不支持获取个人资料照片，返回空数组');
                return resolve([]);
            }
            
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/getUserProfilePhotos?user_id=${TELEGRAM_CHAT_ID}&limit=100`,
                method: 'GET',
                timeout: 10000 // 10秒超时
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', async () => {
                    try {
                        const response = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            // 提取所有照片信息
                            const photos = [];
                            if (response.ok && response.result && response.result.photos) {
                                for (const photoGroup of response.result.photos) {
                                    // 每组照片中，最后一张是最大分辨率的
                                    const largestPhoto = photoGroup[photoGroup.length - 1];
                                    if (largestPhoto && largestPhoto.file_id) {
                                        const fileId = largestPhoto.file_id;
                                        
                                        // 获取文件路径
                                        const fileResponse = await getTelegramFilePath(fileId);
                                        if (fileResponse.ok && fileResponse.result.file_path) {
                                            // 构建图片URL
                                            const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileResponse.result.file_path}`;
                                            
                                            // 添加到图片数组
                                            photos.push({
                                                ...largestPhoto,
                                                url: imageUrl,
                                                type: 'user_profile'
                                            });
                                        }
                                    }
                                }
                            }
                            resolve(photos);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${response.description || 'Unknown error'}`));
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse getUserProfilePhotos response: ${error.message}`));
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.end();
        } catch (error) {
            reject(error);
        }
    });
}

// 获取聊天消息中的图片
async function getChatPhotos() {
    return new Promise((resolve, reject) => {
        try {
            const photos = [];
            const isChannel = TELEGRAM_CHAT_ID.startsWith('-');
            
            if (isChannel) {
                console.log('检测到频道，尝试获取频道历史消息...');
                
                // 对于频道，我们需要使用不同的方法获取历史消息
                // 首先尝试获取频道信息
                const chatOptions = {
                    hostname: 'api.telegram.org',
                    port: 443,
                    path: `/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${TELEGRAM_CHAT_ID}`,
                    method: 'GET',
                    timeout: 10000 // 10秒超时
                };
                
                const chatReq = https.request(chatOptions, (chatRes) => {
                    let chatData = '';
                    chatRes.on('data', (chunk) => {
                        chatData += chunk;
                    });
                    chatRes.on('end', async () => {
                        try {
                            const chatResponse = JSON.parse(chatData);
                            if (chatRes.statusCode >= 200 && chatRes.statusCode < 300) {
                                if (chatResponse.ok) {
                                    console.log('成功获取频道信息:', chatResponse.result.title);
                                    
                                    // 尝试使用searchChatHistory方法获取历史消息
                                    // 注意：这个方法可能需要bot是频道的管理员
                                    await getChannelHistoryMessages(photos, resolve, reject);
                                } else {
                                    console.error('获取频道信息失败:', chatResponse.description);
                                    // 如果获取频道信息失败，尝试使用getUpdates作为后备方案
                                    await getUpdatesFallback(photos, resolve, reject, true);
                                }
                            } else {
                                console.error(`获取频道信息HTTP错误: ${chatRes.statusCode}`);
                                // 如果获取频道信息失败，尝试使用getUpdates作为后备方案
                                    await getUpdatesFallback(photos, resolve, reject, true);
                            }
                        } catch (error) {
                            console.error('解析频道信息响应失败:', error.message);
                            // 如果解析失败，尝试使用getUpdates作为后备方案
                                    await getUpdatesFallback(photos, resolve, reject, true);
                        }
                    });
                });
                
                chatReq.on('error', (error) => {
                    console.error('获取频道信息请求失败:', error);
                    // 如果请求失败，尝试使用getUpdates作为后备方案
                    getUpdatesFallback(photos, resolve, reject, true);
                });
                
                chatReq.on('timeout', () => {
                    chatReq.destroy();
                    console.error('获取频道信息请求超时');
                    // 如果请求超时，尝试使用getUpdates作为后备方案
                    getUpdatesFallback(photos, resolve, reject, true);
                });
                
                chatReq.end();
            } else {
                // 对于普通聊天，使用getUpdates方法
            getUpdatesFallback(photos, resolve, reject, false);
            }
        } catch (error) {
            reject(error);
        }
    });
}

// 获取频道历史消息的辅助函数
async function getChannelHistoryMessages(photos, resolve, reject) {
    try {
        console.log(`开始获取频道 ${TELEGRAM_CHAT_ID} 的消息...`);
        
        // 注意：Telegram Bot API有以下限制：
        // 1. getUpdates方法只能获取新的消息更新，无法获取历史消息
        // 2. 如果机器人长时间未运行，可能会错过一些消息（通常有24-48小时的限制）
        // 3. 没有直接的方法可以获取任意时间点的历史消息
        console.log('使用getUpdates方法获取消息更新（仅限新消息，无法获取历史消息）...');
        await getUpdatesFallback(photos, resolve, reject, true);
    } catch (error) {
        console.error('getUpdates方法失败:', error.message);
        reject(error);
    }
}

// 辅助函数：发送HTTP请求
function makeRequest(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        req.end();
    });
}

// 处理消息的辅助函数
async function processMessages(messages, photos) {
    console.log(`开始处理 ${messages.length} 条消息`);
    for (const message of messages) {
        // 处理照片消息
        if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
            // 获取最高分辨率的照片（数组中的最后一个）
            const photo = message.photo[message.photo.length - 1];
            if (photo && photo.file_id) {
                const fileId = photo.file_id;
                
                console.log(`处理照片消息: ${fileId}, 消息ID: ${message.message_id}, 时间: ${new Date(message.date * 1000).toISOString()}`);
                
                // 获取文件路径
                const fileResponse = await getTelegramFilePath(fileId);
                if (fileResponse.ok && fileResponse.result.file_path) {
                    // 构建图片URL
                    const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileResponse.result.file_path}`;
                    
                    // 添加到图片数组
                    photos.push({
                        file_id: fileId,
                        ...photo,
                        url: imageUrl,
                        type: 'message_photo',
                        messageId: message.message_id,
                        from: message.from?.id || 'channel',
                        date: message.date * 1000, // 转换为毫秒时间戳
                        caption: message.caption || ''
                    });
                } else {
                    console.log(`获取文件路径失败: ${fileId}, 错误: ${fileResponse.description || 'Unknown error'}`);
                }
            }
        }
        
        // 处理消息中的文档（可能是图片）
        if (message.document && message.document.file_id && message.document.mime_type) {
            // 检查是否是图片类型
            if (message.document.mime_type.startsWith('image/')) {
                const fileId = message.document.file_id;
                
                console.log(`处理文档图片: ${fileId}, 消息ID: ${message.message_id}, 时间: ${new Date(message.date * 1000).toISOString()}`);
                
                // 获取文件路径
                const fileResponse = await getTelegramFilePath(fileId);
                if (fileResponse.ok && fileResponse.result.file_path) {
                    // 构建图片URL
                    const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileResponse.result.file_path}`;
                    
                    // 添加到图片数组
                    photos.push({
                        file_id: fileId,
                        url: imageUrl,
                        type: 'document_image',
                        messageId: message.message_id,
                        from: message.from?.id || 'channel',
                        date: message.date * 1000, // 转换为毫秒时间戳
                        caption: message.caption || '',
                        fileName: message.document.file_name || '',
                        mimeType: message.document.mime_type,
                        fileSize: message.document.file_size || 0
                    });
                } else {
                    console.log(`获取文件路径失败: ${fileId}, 错误: ${fileResponse.description || 'Unknown error'}`);
                }
            }
        }
    }
    console.log(`处理完成，共添加 ${photos.length} 张图片`);
}

// getUpdates的后备方案，实现增量同步
async function getUpdatesFallback(photos, resolve, reject, forceFullSync = false) {
    try {
        console.log('开始使用getUpdates方法获取消息更新...');
        
        // 获取上次同步的update_id
        const lastUpdateId = await getLastUpdateId();
        console.log(`上次同步的update_id: ${lastUpdateId}`);
        
        // 如果是强制全量同步或者是第一次同步，则从-1开始
        let offset = forceFullSync || lastUpdateId === 0 ? -1 : lastUpdateId + 1;
        console.log(`本次同步使用的offset: ${offset}, 强制全量同步: ${forceFullSync}`);
        
        let allPhotos = [];
        let hasMore = true;
        let totalUpdates = 0;
        let maxUpdateId = lastUpdateId; // 记录本次同步获取到的最大update_id
        const maxUpdates = 1000; // 限制最大获取数量
        
        while (hasMore && totalUpdates < maxUpdates) {
            const offsetParam = offset > 0 ? `&offset=${offset}` : '';
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100${offsetParam}&allowed_updates=["message","channel_post"]`,
                method: 'GET',
                timeout: 15000 // 15秒超时
            };
            
            console.log(`正在请求getUpdates API (offset: ${offset})...`);
            
            const response = await new Promise((reqResolve, reqReject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            const parsedResponse = JSON.parse(data);
                            reqResolve({ statusCode: res.statusCode, data: parsedResponse });
                        } catch (error) {
                            reqReject(new Error(`Failed to parse response: ${error.message}`));
                        }
                    });
                });
                
                req.on('error', (error) => {
                    reqReject(error);
                });
                
                req.on('timeout', () => {
                    req.destroy();
                    reqReject(new Error('Request timeout'));
                });
                
                req.end();
            });
            
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const { data } = response;
                
                if (data.ok && data.result && Array.isArray(data.result)) {
                    console.log(`getUpdates API返回成功，获取到 ${data.result.length} 条更新`);
                    totalUpdates += data.result.length;
                    
                    // 处理消息更新
                    const messages = data.result.map(update => update.message || update.channel_post).filter(Boolean);
                    console.log(`从更新中提取出 ${messages.length} 条消息`);
                    
                    // 处理消息并添加到临时数组
                    const tempPhotos = [];
                    await processMessages(messages, tempPhotos);
                    allPhotos.push(...tempPhotos);
                    
                    // 检查是否还有更多更新
                    if (data.result.length > 0) {
                        // 设置下一次请求的offset为最后一个update_id + 1
                        offset = data.result[data.result.length - 1].update_id + 1;
                        // 更新本次同步获取到的最大update_id
                        maxUpdateId = Math.max(maxUpdateId, data.result[data.result.length - 1].update_id);
                    } else {
                        hasMore = false;
                    }
                } else {
                    console.log('没有获取到消息更新');
                    if (!data.ok) {
                        console.error('getUpdates API返回错误:', data.description);
                    }
                    hasMore = false;
                }
            } else {
                console.error(`getUpdates API HTTP错误: ${response.statusCode}`);
                hasMore = false;
            }
        }
        
        console.log(`getUpdates总共获取了 ${totalUpdates} 条更新，其中包含 ${allPhotos.length} 张图片`);
        
        // 如果获取到了新的更新，更新last_update_id
        if (maxUpdateId > lastUpdateId) {
            await setLastUpdateId(maxUpdateId);
            console.log(`更新last_update_id为: ${maxUpdateId}`);
        }
        
        // 去重：根据file_id去除重复的图片
        const uniquePhotos = [];
        const seenFileIds = new Set();
        
        for (const photo of allPhotos) {
            if (photo.file_id && !seenFileIds.has(photo.file_id)) {
                seenFileIds.add(photo.file_id);
                uniquePhotos.push(photo);
            }
        }
        
        console.log(`去重后有 ${uniquePhotos.length} 张唯一图片`);
        photos.push(...uniquePhotos);
        resolve(photos);
    } catch (error) {
        console.error('getUpdatesFallback函数执行失败:', error);
        reject(error);
    }
}

// 获取Telegram文件路径
async function getTelegramFilePath(fileId) {
    return new Promise((resolve, reject) => {
        try {
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
                method: 'GET',
                timeout: 10000 // 10秒超时
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(response);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${response.description || 'Unknown error'}`));
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse getFile response: ${error.message}`));
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.end();
        } catch (error) {
            reject(error);
        }
    });
}

