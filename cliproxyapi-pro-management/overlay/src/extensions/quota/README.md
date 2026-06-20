# 配额持久化扩展

本扩展为配额管理系统添加了 IndexedDB 持久化功能，使配额数据在页面刷新后仍然可用。

## 功能特性

- **IndexedDB 持久化**：配额数据自动保存到浏览器 IndexedDB，支持大容量存储（最多 500 个文件）
- **LRU 自动清理**：当缓存条目超过 500 个时，自动删除最旧的 20%
- **缓存时间戳**：每张配额卡片显示数据获取时间（如"5 分钟前"）
- **单卡刷新**：success 状态下也可以单独刷新某张卡片
- **特性开关**：通过 `src/config/features.ts` 控制功能启用/禁用

## 架构设计

```
┌─────────────────────────────────┐
│ 内存层 (Zustand Store)          │
│ - 当前页面可见的配额数据         │
│ - 快速访问，无序列化开销         │
└─────────────────────────────────┘
                ↓ ↑
┌─────────────────────────────────┐
│ 持久化中间件                     │
│ - 监听 store 变化                │
│ - 自动同步到 IndexedDB           │
│ - 页面加载时预加载缓存           │
└─────────────────────────────────┘
                ↓ ↑
┌─────────────────────────────────┐
│ IndexedDB 层                     │
│ - 最多存储 500 个文件配额        │
│ - LRU 自动淘汰                   │
│ - 支持批量读写                   │
└─────────────────────────────────┘
```

## 文件结构

```
src/
├─ config/
│   └─ features.ts                 ← 特性开关配置
├─ extensions/                     ← 扩展目录（我们的代码）
│   └─ quota/
│       ├─ indexedDBCache.ts       ← IndexedDB 封装类
│       ├─ persistenceMiddleware.ts ← Zustand 持久化中间件
│       └─ README.md               ← 本文档
├─ types/quota.ts                  ← 类型定义（添加 cachedAt 字段）
├─ components/quota/
│   ├─ quotaConfigs.ts             ← 配置（buildSuccessState 添加时间戳）
│   └─ QuotaCard.tsx               ← 卡片组件（显示时间戳和刷新按钮）
└─ pages/
    └─ QuotaPage.tsx               ← 页面入口（初始化中间件）
```

## 上游自动整合

本扩展的上游最小修改被单独提取在当前仓库的 `customizations/quota-persistence/`：

- `overlay/`：直接复制到上游项目中的新增文件，例如 `src/config/features.ts` 和 `src/extensions/quota/`
- `quota-persistence.patch`：对上游既有文件的最小 patch
- `apply.sh`：把 overlay 和 patch 应用到任意上游代码目录

```bash
# 在本地上游目录中套用本扩展
customizations/quota-persistence/apply.sh /path/to/Cli-Proxy-API-Management-Center

# 在本项目中检查/同步默认本地上游目录
npm run sync:upstream -- --check
npm run sync:upstream -- --apply
```

GitHub Actions 会先比较本仓库 latest release 和上游 latest release，比较时会忽略本仓库的 `-plus` 后缀。只有上游版本更新时，才会 checkout 上游 release tag，执行 `customizations/quota-persistence/apply.sh upstream`，然后安装依赖、构建并发布 `上游版本-plus` 格式的 GitHub Release。

## 上游依赖

本扩展依赖以下上游接口，上游更新时需要检查兼容性：

### 1. Zustand Store 结构

**文件**: `src/stores/useQuotaStore.ts`

**依赖字段**:
```typescript
{
  antigravityQuota: Record<string, AntigravityQuotaState>
  claudeQuota: Record<string, ClaudeQuotaState>
  codexQuota: Record<string, CodexQuotaState>
  kimiQuota: Record<string, KimiQuotaState>
  xaiQuota: Record<string, XaiQuotaState>
  setAntigravityQuota: (updater) => void
  setClaudeQuota: (updater) => void
  setCodexQuota: (updater) => void
  setKimiQuota: (updater) => void
  setXaiQuota: (updater) => void
  clearQuotaCache: () => void
}
```

### 2. QuotaStatusState 接口

**文件**: `src/types/quota.ts`

**依赖字段**:
```typescript
interface QuotaStatusState {
  status: 'idle' | 'loading' | 'success' | 'error'
  cachedAt?: number  // 我们新增的字段
}
```

所有 provider 的 state 接口都继承此基础结构：
- `AntigravityQuotaState`
- `ClaudeQuotaState`
- `CodexQuotaState`
- `KimiQuotaState`
- `XaiQuotaState`

### 3. QuotaConfig 的 buildSuccessState

**文件**: `src/components/quota/quotaConfigs.ts`

**修改点**: 所有 `buildSuccessState` 方法都添加了 `cachedAt: Date.now()`

```typescript
buildSuccessState: (data) => ({
  status: 'success',
  // ... 其他字段
  cachedAt: Date.now(),  // 新增
})
```

## 上游更新检查清单

当上游有更新时，按以下步骤检查兼容性：

### 1. 检查 Store 结构

```bash
# 检查 useQuotaStore 的字段名是否变更
grep -A 20 "export const useQuotaStore" src/stores/useQuotaStore.ts
```

**如果变更**：更新 `persistenceMiddleware.ts` 中的 `checkCompatibility()` 方法

### 2. 检查类型定义

```bash
# 检查 QuotaStatusState 是否有新字段
grep -A 5 "interface.*QuotaState" src/types/quota.ts
```

**如果变更**：
1. 更新 `indexedDBCache.ts` 中的 `dataVersion` 常量（递增）
2. 添加数据迁移逻辑（如果需要）

### 3. 检查 buildSuccessState

```bash
# 检查是否所有 buildSuccessState 都有 cachedAt
grep -A 3 "buildSuccessState" src/components/quota/quotaConfigs.ts | grep cachedAt
```

**如果缺失**：手动添加 `cachedAt: Date.now()`

### 4. 运行兼容性测试

```typescript
// 在浏览器控制台运行
import { quotaPersistenceMiddleware } from '@/extensions/quota/persistenceMiddleware';

// 检查中间件是否正常启动
quotaPersistenceMiddleware.start();

// 查看统计信息
await quotaPersistenceMiddleware.getStats();
```

## 数据迁移

如果上游修改了 `QuotaStatusState` 的结构，需要添加迁移逻辑：

```typescript
// src/extensions/quota/indexedDBCache.ts

const CURRENT_DATA_VERSION = 2;  // 递增版本号

async get(provider, fileName) {
  const entry = await this.getRaw(provider, fileName);
  if (!entry) return null;

  // 版本检查
  if (entry.version < CURRENT_DATA_VERSION) {
    entry.data = this.migrate(entry.data, entry.version, CURRENT_DATA_VERSION);
    entry.version = CURRENT_DATA_VERSION;
    await this.set(provider, fileName, entry.data, entry.cachedAt);
  }

  return entry.data;
}

private migrate(data, fromVersion, toVersion) {
  // v1 -> v2: 添加 planType 字段
  if (fromVersion === 1 && toVersion === 2) {
    return { ...data, planType: null };
  }
  return data;
}
```

## 特性开关

**文件**: `src/config/features.ts`

```typescript
export const FEATURES = {
  QUOTA_PERSISTENCE: true,        // 启用 IndexedDB 持久化
  QUOTA_CACHE_TIMESTAMP: true,    // 显示缓存时间戳
};
```

**临时禁用**：如果上游更新导致冲突，可以临时关闭特性：

```typescript
export const FEATURES = {
  QUOTA_PERSISTENCE: false,  // 禁用持久化，回退到纯内存模式
  // ...
};
```

## 调试工具

### 查看缓存统计

```typescript
import { indexedDBQuotaCache } from '@/extensions/quota/indexedDBCache';

// 查看缓存统计
const stats = await indexedDBQuotaCache.getStats();
console.log(stats);
// { totalEntries: 350, byProvider: { claude: 120, codex: 230 } }
```

### 清空缓存

```typescript
import { quotaPersistenceMiddleware } from '@/extensions/quota/persistenceMiddleware';

// 清空所有缓存
await quotaPersistenceMiddleware.clearCache();
```

### 手动触发同步

```typescript
// 中间件会自动同步，但如果需要手动触发：
import { useQuotaStore } from '@/stores';

// 修改 store 后，中间件会在 500ms 后自动同步到 IndexedDB
useQuotaStore.getState().setClaudeQuota({ /* ... */ });
```

## 性能优化

### 1. 防抖同步

中间件使用 500ms 防抖，避免频繁写入 IndexedDB：

```typescript
// persistenceMiddleware.ts
private syncTimer: ReturnType<typeof setTimeout> | null = null;

private syncProvider(provider, quotaMap) {
  // 添加到队列
  this.syncQueue.add(key);

  // 防抖：500ms 后批量同步
  if (this.syncTimer) clearTimeout(this.syncTimer);
  this.syncTimer = setTimeout(() => {
    this.flushSyncQueue();
  }, 500);
}
```

### 2. 批量读取

页面加载时使用批量读取，减少 IndexedDB 事务次数：

```typescript
// indexedDBCache.ts
async batchGet(provider: string, fileNames: string[]): Promise<Map<string, any>> {
  // 一次事务读取所有文件
  const transaction = db.transaction([STORE_QUOTAS], 'readwrite');
  // ...
}
```

### 3. LRU 自动清理

当缓存超过 500 条时，自动删除最旧的 20%：

```typescript
// indexedDBCache.ts
private async cleanupIfNeeded() {
  if (metadata.totalEntries <= metadata.maxEntries) return;

  // 按 accessedAt 排序，删除最旧的 20%
  const deleteCount = Math.ceil(allEntries.length * 0.2);
  // ...
}
```

## 常见问题

### Q: 页面刷新后配额数据没有恢复？

**A**: 检查以下几点：
1. `FEATURES.QUOTA_PERSISTENCE` 是否为 `true`
2. 浏览器控制台是否有错误日志
3. 运行 `await indexedDBQuotaCache.getStats()` 查看缓存是否存在

### Q: 如何完全禁用持久化功能？

**A**: 修改 `src/config/features.ts`：

```typescript
export const FEATURES = {
  QUOTA_PERSISTENCE: false,
  QUOTA_CACHE_TIMESTAMP: false,
};
```

### Q: 上游更新后中间件无法启动？

**A**: 查看浏览器控制台，中间件会输出兼容性检查失败的字段名：

```
QuotaPersistenceMiddleware: Missing fields: setNewProviderQuota
```

然后更新 `persistenceMiddleware.ts` 的 `checkCompatibility()` 方法。

### Q: 如何清理旧版本的缓存数据？

**A**: 递增 `indexedDBCache.ts` 中的 `DB_VERSION`，IndexedDB 会自动触发 `onupgradeneeded` 重建数据库。

## 贡献指南

如果需要扩展功能，请遵循以下原则：

1. **最小侵入**：尽量不修改上游文件，所有新代码放在 `src/extensions/` 目录
2. **向后兼容**：添加新功能时，确保旧数据仍然可用
3. **特性开关**：新功能通过 `FEATURES` 开关控制，方便禁用
4. **文档更新**：修改后更新本 README 的"上游依赖"部分

## 许可证

本扩展遵循主项目的许可证。
