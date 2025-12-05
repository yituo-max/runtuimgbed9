// 从 admin-login.js 导入验证函数
const { verifyAdminToken } = require('./admin-login');

// 导出验证函数供其他模块使用
module.exports = {
    verifyAdminToken
};