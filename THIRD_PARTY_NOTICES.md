# 第三方代码与素材声明

本仓库的**主体**（规则引擎、信念系统、战术层、界面）为本项目原创；
但**搜索架构与棋盘模型**改编自一个 MIT 许可的开源项目，按 MIT 的要求必须保留其声明。

---

## 1. BitByBitG/siguo-junqi（MIT）

- 项目地址：https://github.com/BitByBitG/siguo-junqi
- 版权：Copyright (c) 2026 BitByBitG
- 许可：MIT License

**改编范围**
| 本仓库文件 | 改编内容 |
|---|---|
| `ai.js` | 搜索架构：信念抽样（PIMC）、选择性 Alpha-Beta、着法排序、子力表 |
| `board.js` | 棋盘模型：17×17 坐标、行营/大本营、公路/铁路、中央九点、直线铁路线 |

规则与数据模型（乱战/标准两种模式、战斗判定、暗牌、军旗规则）按本项目的玩法重写，
并非原项目的实现；`ai.js` 内的评估函数、信念层、战术层为本项目原创。

原许可全文：

```
MIT License

Copyright (c) 2026 BitByBitG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 素材（图片 / 音效）

| 文件 | 说明 |
|---|---|
| `assets/board.png` | 棋盘底图（纯线条示意图，无任何游戏 UI、文字或商标）。若你对外分发，建议自行确认来源；不确定时可直接用 CSS 绘制替代（`style.css` 中只有一处 `url()` 引用）。 |
| `assets/shots/*.png` | 本项目运行截图，自制。 |
| `sounds/*.wav` | 8 个极短的通用音效（走子/吃子/阵亡/兑子/亮旗/开局/按钮）。来源不明，若担心版权请替换为 CC0 音效（如 freesound.org 的 CC0 集合）或删除 `ui.js` 中的 `SOUND` 映射即可静音。 |

**没有**包含任何游戏客户端的图片资源、字体、商标或反编译产物。

---

## 3. 训练数据

`formation_joint_data.js`、`formations_human.js` 等阵型统计由**人类对局记录**聚合而来，
仓库中只保留**聚合后的统计量**（阵型频次、条件概率表），不包含原始对局文件、
不包含玩家 ID、不包含任何个人信息。
