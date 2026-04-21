# PHPUnit 通用範本

本目錄提供 [phpunit.xml.dist](./phpunit.xml.dist) 作為各專案撰寫單元測試的起手模板。

**請注意**：根據 [docs/project-convention.md](../../docs/project-convention.md)，
**單元測試必須由每個專案自己維護**，流水線只負責呼叫 `phpunit` 執行。

## 在新專案套用

```bash
mkdir -p /path/to/your-project/.testing/unit/tests
cp /mnt/e/Code/github/automated-testing-pipeline/tests/unit/phpunit.xml.dist \
   /path/to/your-project/.testing/unit/phpunit.xml
```

然後：

1. 在 `<project>/.testing/unit/tests/` 下撰寫 `*Test.php`
2. （選）建立 `<project>/.testing/unit/bootstrap.php` 載入 autoloader
3. 在 `<project>/.testing/testing.yml` 啟用：
   ```yaml
   tests:
     unit:
       enabled: true
   ```
4. 執行：`bash scripts/run-project.sh <name> unit`

## 典型目錄結構

```
<project>/.testing/unit/
├── phpunit.xml
├── bootstrap.php
└── tests/
    ├── UserTest.php
    └── Service/
        └── PaymentServiceTest.php
```
