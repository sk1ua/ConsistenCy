# ConsistenCy 代码不一致标注指南

## 📋 版本信息
- **版本**：1.0
- **日期**：2026-03-10
- **标注员资格**：CS 背景 + 至少 1 年代码审查经验

---

## 🎯 标注目标

评估 Git 提交是否引入了**与现有代码库不一致的代码风格、结构或逻辑模式**。

**注意**：我们关注的是"不一致性"，而不是"代码质量"。一个提交可能代码质量很高，但如果和项目其他代码风格不一致，仍然应该标记为高风险。

---

## 📏 标注维度

对每个提交，在三个维度上进行评分：

### 1. 风格不一致（Style Inconsistency）
**定义**：命名规范、格式化、注释风格与现有代码库不匹配

**评分标准**（1-5 分）：
- **1 - 完全一致**：完全遵循项目风格
  - 例：函数命名符合 `snake_case`，类命名符合 `PascalCase`，与项目其他代码一致
  
- **2 - 轻微不一致**：偶尔的小偏差
  - 例：90% 的命名一致，1-2 个函数命名风格略有不同
  
- **3 - 中等不一致**：明显的风格混用
  - 例：同一文件内混用 `camelCase` 和 `snake_case`
  
- **4 - 严重不一致**：大范围风格偏离
  - 例：整个模块使用与项目不同的命名规范
  
- **5 - 完全不一致**：引入全新且冲突的风格
  - 例：在 Python 项目中使用 Java 风格命名

### 2. 结构不一致（Structure Inconsistency）
**定义**：代码组织、模块划分、函数复杂度与项目模式不匹配

**评分标准**（1-5 分）：
- **1 - 完全一致**：结构符合项目模式
  - 例：函数长度、类设计与现有代码类似
  
- **2 - 轻微不一致**：小的结构差异
  - 例：函数稍长（120 行 vs 项目平均 80 行），但仍可接受
  
- **3 - 中等不一致**：明显的结构偏差
  - 例：引入过长的函数（200+ 行），而项目其他函数均 < 100 行
  
- **4 - 严重不一致**：结构模式冲突
  - 例：在函数式风格项目中引入大量类层次结构
  
- **5 - 完全不一致**：完全不同的架构模式
  - 例：在模块化项目中引入单体式巨型文件

### 3. 逻辑不一致（Logic Inconsistency）
**定义**：算法选择、API 使用、错误处理模式与代码库习惯不一致

**评分标准**（1-5 分）：
- **1 - 完全一致**：逻辑模式符合项目习惯
  - 例：使用与现有代码相同的设计模式和库
  
- **2 - 轻微不一致**：小的逻辑差异
  - 例：使用略有不同但合理的算法实现
  
- **3 - 中等不一致**：逻辑模式偏离
  - 例：项目其他地方用列表推导式，此处用传统 for 循环
  
- **4 - 严重不一致**：引入冲突的逻辑模式
  - 例：项目统一用 requests 库，此处突然用 urllib
  
- **5 - 完全不一致**：完全不同的技术栈
  - 例：在 async 项目中引入同步阻塞调用

---

## 📊 整体风险等级

基于三个维度的分数，给出整体判断：

**低风险（Low Risk）**：
- 所有维度 ≤ 2
- 提交与项目代码高度一致
- **标签**：`0`

**中风险（Medium Risk）**：
- 至少一个维度 = 3，或两个维度 = 2
- 存在明显但可接受的不一致
- **标签**：`1`（边界情况，倾向标为 0 或 1）

**高风险（High Risk）**：
- 至少一个维度 ≥ 4，或两个维度 ≥ 3
- 不一致性可能影响代码维护和团队协作
- **标签**：`1`

---

## 🔍 标注流程

### 步骤 1：准备阶段
1. 浏览项目的 README 和代码规范（如有）
2. 随机查看项目的 5-10 个文件，了解主流风格
3. 记录项目的主要特征：
   - 命名风格（snake_case, camelCase, PascalCase）
   - 平均函数长度
   - 注释密度
   - 使用的主要库和模式

### 步骤 2：分析提交
1. 阅读提交 diff，关注：
   - 新增/修改的函数和类
   - 变量命名
   - 代码结构和复杂度
   - 使用的库和 API
   
2. 对比：
   - 将此提交与项目现有代码对比
   - 不要与"完美代码"或"你的个人偏好"对比
   - 问自己："这个提交看起来像是同一个团队/风格指南写的吗？"

### 步骤 3：评分
1. 分别对 Style/Structure/Logic 三个维度打分（1-5）
2. 给出整体风险标签（0 或 1）
3. （可选）添加简短备注说明原因

### 步骤 4：质量检查
- 每标注 20 个样本后休息 5 分钟
- 避免疲劳标注
- 如果不确定，标记为"需要讨论"

---

## 📝 标注示例

### 示例 1：低风险提交

**提交信息**：
```
feat: add user authentication helper

+ def validate_user_credentials(username, password):
+     """验证用户凭证"""
+     if not username or not password:
+         return False
+     user = database.get_user(username)
+     return user and user.check_password(password)
```

**项目背景**：
- Python Web 项目，所有函数使用 `snake_case`
- 平均函数长度 10-20 行
- 统一使用 `database` 模块访问数据库

**评分**：
- Style: **1** (命名、注释风格与项目一致)
- Structure: **1** (函数长度合理，单一职责)
- Logic: **1** (使用项目标准的 database API)
- **整体标签**：`0` (低风险)

**备注**：完全符合项目规范

---

### 示例 2：高风险提交

**提交信息**：
```
feat: add data processing

+ class DataProcessor:
+     def ProcessUserData(self, UserList):
+         ResultList = []
+         for i in range(len(UserList)):
+             currentUser = UserList[i]
+             if currentUser['age'] > 18:
+                 # 直接操作数据库
+                 import sqlite3
+                 conn = sqlite3.connect('users.db')
+                 cursor = conn.cursor()
+                 cursor.execute("INSERT INTO adults VALUES (?)", 
+                                (currentUser['name'],))
+                 conn.commit()
+                 ResultList.append(currentUser)
+         return ResultList
```

**项目背景**：
- Python 项目，统一使用 `snake_case` 命名
- 函数式风格为主，很少使用类
- 统一通过 ORM（如 SQLAlchemy）访问数据库
- 平均函数长度 15 行

**评分**：
- Style: **4** (混用 `camelCase` 和 `snake_case`，与项目风格严重冲突)
- Structure: **4** (引入类但项目主要是函数式；函数过长且职责混杂)
- Logic: **5** (直接使用 sqlite3 而非项目标准 ORM；在循环中打开数据库连接)
- **整体标签**：`1` (高风险)

**备注**：多个维度严重不一致，需要重构以符合项目规范

---

### 示例 3：边界案例（中风险）

**提交信息**：
```
refactor: optimize query performance

+ def get_recent_orders(self, limit=100):
+     # 使用原生 SQL 优化性能
+     query = """
+         SELECT * FROM orders 
+         WHERE created_at > NOW() - INTERVAL '7 days'
+         ORDER BY created_at DESC
+         LIMIT %s
+     """
+     return self.db.execute_raw(query, (limit,))
```

**项目背景**：
- 项目通常使用 ORM 查询（Django ORM）
- 但性能关键路径偶尔使用原生 SQL
- 数据库访问有统一的 `db.execute_raw()` 方法

**评分**：
- Style: **2** (命名一致，注释清晰，轻微不一致：注释放在函数定义后而非 docstring)
- Structure: **1** (函数长度和复杂度合理)
- Logic: **3** (使用原生 SQL 偏离常规 ORM，但项目允许且有先例)
- **整体标签**：`0` 或 `1`（判断依赖项目对原生 SQL 的容忍度）

**备注**：边界案例，如果项目明确允许性能优化时使用原生 SQL → 标为 0；如果这种做法罕见 → 标为 1

---

## 🤝 标注员一致性

### Inter-rater Agreement 目标
- Cohen's Kappa ≥ **0.70** (substantial agreement)
- 如果 Kappa < 0.70，需要：
  1. 重新培训标注员
  2. 澄清指南中的模糊点
  3. 讨论分歧案例

### 分歧解决机制
1. 如果两位标注员在整体标签上分歧（一个 0，一个 1）：
   - 第三位标注员介入
   - 三人讨论直到达成共识
   - 记录讨论结果和最终决定

2. 如果在维度评分上差异 > 1 分（如一个打 2，另一个打 4）：
   - 标记为"高分歧样本"
   - 团队会议讨论
   - 可能调整指南

---

## ⚠️ 常见陷阱

### 陷阱 1：混淆"质量"与"一致性"
- ❌ 错误：这个函数效率低，所以是高风险
- ✅ 正确：这个函数的实现方式与项目其他函数不同，所以是高风险

### 陷阱 2：个人偏好
- ❌ 错误：我不喜欢这种写法，所以打低分
- ✅ 正确：项目其他代码都这么写，所以即使我不喜欢，也应该打高分（一致性高）

### 陷阱 3：忽略上下文
- ❌ 错误：这个变量名太长了（50 个字符），高风险
- ✅ 正确：项目其他地方也用长描述性变量名，所以这是一致的

### 陷阱 4：过于宽容
- ❌ 错误："这种写法也还行吧"→ 打 2 分
- ✅ 正确：与项目 90% 的代码风格不同 → 应该打 4 分

---

## 📊 标注数据格式

每个样本的 JSON 格式：

```json
{
  "commit_sha": "39708b9d...",
  "project": "faif/python-patterns",
  "annotator_id": "annotator_001",
  "timestamp": "2026-03-10T14:30:00Z",
  
  "scores": {
    "style": 2,
    "structure": 1,
    "logic": 3
  },
  
  "overall_label": 0,
  
  "comments": "Logic score 3 because it uses raw SQL instead of ORM, but this is acceptable for performance-critical paths.",
  
  "confidence": "high",  // high, medium, low
  "discussion_needed": false
}
```

---

## 📞 联系与支持

- 技术问题：提前审查标注工具 UI 教程
- 指南澄清：团队每周一次标注员会议
- 紧急情况：联系项目负责人

---

## ✅ 标注前检查清单

在开始标注前，确认：

- [ ] 已阅读并理解本指南
- [ ] 已完成 10 个练习样本的标注
- [ ] 练习样本的一致性达到 Kappa > 0.7
- [ ] 了解项目背景（浏览了项目 README 和代码）
- [ ] 标注工具已正常运行

---

**祝标注顺利！高质量的标注是研究成功的基石。**
