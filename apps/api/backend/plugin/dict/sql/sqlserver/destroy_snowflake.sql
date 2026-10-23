DELETE FROM sys_menu WHERE name IN ('AddDictType', 'EditDictType', 'DeleteDictType', 'AddDictData', 'EditDictData', 'DeleteDictData', 'QueryDictType', 'QueryDictData', 'ExportDictData', 'ImportDictData');

DELETE FROM sys_menu WHERE name = 'PluginDict';

DROP TABLE IF EXISTS sys_dict_data;
DROP TABLE IF EXISTS sys_dict_type;
