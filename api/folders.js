// 文件夹管理API
const { createClient } = require('@vercel/kv');
const { verifyAdminToken } = require('./auth-middleware');

// 创建KV客户端
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 键名前缀
const FOLDERS_KEY = 'imgbed:folders';

// 获取所有文件夹
async function getFolders() {
  try {
    const foldersData = await kv.get(FOLDERS_KEY);
    return foldersData ? JSON.parse(foldersData) : [];
  } catch (error) {
    console.error('Error getting folders:', error);
    return [];
  }
}

// 创建新文件夹
async function createFolder(name, parentId = null) {
  try {
    const folders = await getFolders();
    const newFolder = {
      id: 'folder_' + Date.now(),
      name: name,
      parentId: parentId,
      createdAt: new Date().toISOString()
    };
    
    folders.push(newFolder);
    await kv.set(FOLDERS_KEY, JSON.stringify(folders));
    
    return newFolder;
  } catch (error) {
    console.error('Error creating folder:', error);
    return null;
  }
}

// 确保必要的文件夹存在
async function ensureFoldersExist() {
  try {
    const folders = await getFolders();
    const requiredFolders = [
      { id: 'avatar', name: '头像', parentId: null },
      { id: 'chat', name: '聊天', parentId: null }
    ];
    
    for (const requiredFolder of requiredFolders) {
      const exists = folders.some(f => f.id === requiredFolder.id);
      if (!exists) {
        await createFolder(requiredFolder.name, requiredFolder.parentId);
        console.log(`创建必要文件夹: ${requiredFolder.name} (${requiredFolder.id})`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring folders exist:', error);
    return false;
  }
}

// API端点处理函数
module.exports = async (req, res) => {
    // 设置CORS头
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    try {
        // 获取所有文件夹
        if (req.method === 'GET') {
            const folders = await getFolders();
            return res.status(200).json({
                success: true,
                folders: folders
            });
        }
        
        // 创建新文件夹
        if (req.method === 'POST') {
            // 验证管理员权限
            const authResult = verifyAdminToken(req);
            if (!authResult.valid) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            
            const { name, parentId } = req.body;
            
            if (!name || name.trim() === '') {
                return res.status(400).json({ error: 'Folder name is required' });
            }
            
            const newFolder = await createFolder(name.trim(), parentId || null);
            
            if (!newFolder) {
                return res.status(500).json({ error: 'Failed to create folder' });
            }
            
            return res.status(201).json({
                success: true,
                message: 'Folder created successfully',
                folder: newFolder
            });
        }
        
        // 其他方法暂不支持
        return res.status(405).json({ error: 'Method Not Allowed' });
        
    } catch (error) {
        console.error('Folders API error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

// 导出辅助函数供其他模块使用
module.exports.getFolders = getFolders;
module.exports.createFolder = createFolder;
module.exports.ensureFoldersExist = ensureFoldersExist;