// ECDICT CSV 转 JSON 工具
// 使用方法：node convert_ecdict.js

const fs = require('fs');
const readline = require('readline');

// 读取 ecdict.csv 并转换为 JSON 格式
async function convertECDict() {
  const inputFile = 'ecdict.csv';
  const outputFile = 'offline_dict.json';
  
  if (!fs.existsSync(inputFile)) {
    console.error('错误：找不到 ecdict.csv 文件');
    console.log('请确保 ecdict.csv 文件在当前目录下');
    return;
  }

  console.log('开始转换 ECDICT 词典...');
  console.log('这可能需要几分钟时间，请耐心等待...');

  const dictionary = {};
  let lineCount = 0;
  let processedCount = 0;

  const fileStream = fs.createReadStream(inputFile, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  // 跳过标题行
  let isFirstLine = true;

  for await (const line of rl) {
    lineCount++;
    
    if (isFirstLine) {
      isFirstLine = false;
      continue; // 跳过标题行
    }

    // 解析 CSV 行（简单处理，假设字段用逗号分隔）
    // ECDICT 格式：word,phonetic,definition,translation,pos,...
    const parts = line.split(',');
    if (parts.length < 4) continue;

    const word = parts[0].trim().toLowerCase();
    const translation = parts[3].trim(); // translation 字段

    // 只保留有效的单词和翻译
    if (word && translation && word.length >= 2 && word.length <= 50) {
      // 如果单词已存在，合并翻译（用分号分隔）
      if (dictionary[word]) {
        if (!dictionary[word].includes(translation)) {
          dictionary[word] = dictionary[word] + '；' + translation;
        }
      } else {
        dictionary[word] = translation;
        processedCount++;
      }
    }

    // 每处理 10000 行显示进度
    if (lineCount % 10000 === 0) {
      console.log(`已处理 ${lineCount} 行，已提取 ${processedCount} 个单词...`);
    }
  }

  console.log(`\n转换完成！`);
  console.log(`总行数：${lineCount}`);
  console.log(`提取单词数：${processedCount}`);

  // 保存为 JSON 文件
  const jsonContent = JSON.stringify(dictionary, null, 2);
  fs.writeFileSync(outputFile, jsonContent, 'utf8');
  
  const fileSize = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(2);
  console.log(`\n已保存到 ${outputFile}`);
  console.log(`文件大小：${fileSize} MB`);
  console.log(`\n现在可以在设置页面导入这个词典文件了！`);
}

convertECDict().catch(console.error);
