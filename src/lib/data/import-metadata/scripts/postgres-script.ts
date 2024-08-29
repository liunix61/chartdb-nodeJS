import {
    DatabaseEdition,
    databaseEditionToLabelMap,
} from '@/lib/domain/database-edition';

export const getPostgresQuery = (
    options: {
        databaseEdition?: DatabaseEdition;
    } = {}
): string => {
    const databaseEdition: DatabaseEdition | undefined =
        options.databaseEdition;
    // Define additional filters based on the database option
    const supabaseFilters = `
                AND connamespace::regnamespace::text NOT IN ('auth', 'extensions', 'pgsodium', 'realtime', 'storage', 'vault')
    `;

    const supabaseColFilter = `
                AND cols.table_schema NOT IN ('auth', 'extensions', 'pgsodium', 'realtime', 'storage', 'vault')
    `;

    const supabaseTableFilter = `
                AND tbls.table_schema NOT IN ('auth', 'extensions', 'pgsodium', 'realtime', 'storage', 'vault')
    `;

    const supabaseIndexesFilter = `
                WHERE schema_name NOT IN ('auth', 'extensions', 'pgsodium', 'realtime', 'storage', 'vault')
    `;

    const supabaseViewsFilter = `
                AND views.schemaname NOT IN ('auth', 'extensions', 'pgsodium', 'realtime', 'storage', 'vault')
    `;

    const timescaleFilters = `
                AND connamespace::regnamespace::text !~ '^(timescaledb_|_timescaledb_)'
    `;

    const timescaleColFilter = `
                AND cols.table_schema !~ '^(timescaledb_|_timescaledb_)'
                AND cols.table_name !~ '^(pg_stat_)'
    `;

    const timescaleTableFilter = `
                AND tbls.table_schema !~ '^(timescaledb_|_timescaledb_)'
                AND tbls.table_name !~ '^(pg_stat_)'
    `;

    const timescaleIndexesFilter = `
                WHERE schema_name !~ '^(timescaledb_|_timescaledb_)'
    `;

    const timescaleViewsFilter = `
                AND views.schemaname !~ '^(timescaledb_|_timescaledb_)'
    `;

    // Define the base query
    const query = `${`/* ${databaseEdition ? databaseEditionToLabelMap[databaseEdition] : 'PostgreSQL'} edition */`}
WITH fk_info${databaseEdition ? '_' + databaseEdition : ''} AS (
    SELECT array_to_string(array_agg(CONCAT('{"schema":"', schema_name, '"',
                                            ',"table":"', replace(table_name::text, '"', ''), '"',
                                            ',"column":"', replace(fk_column::text, '"', ''), '"',
                                            ',"foreign_key_name":"', foreign_key_name, '"',
                                            ',"reference_table":"', reference_table, '"',
                                            ',"reference_column":"', reference_column, '"',
                                            ',"fk_def":"', fk_def,
                                            '"}')), ',') as fk_metadata
    FROM (
        SELECT  connamespace::regnamespace::text AS schema_name,
                conname AS foreign_key_name,
                conrelid::regclass AS table_name,
                (regexp_matches(pg_get_constraintdef(oid), 'FOREIGN KEY \\((\\w+)\\) REFERENCES (\\w+)\\((\\w+)\\)', 'g'))[1] AS fk_column,
                (regexp_matches(pg_get_constraintdef(oid), 'FOREIGN KEY \\((\\w+)\\) REFERENCES (\\w+)\\((\\w+)\\)', 'g'))[2] AS reference_table,
                (regexp_matches(pg_get_constraintdef(oid), 'FOREIGN KEY \\((\\w+)\\) REFERENCES (\\w+)\\((\\w+)\\)', 'g'))[3] AS reference_column,
                pg_get_constraintdef(oid) as fk_def
        FROM
            pg_constraint
        WHERE
            contype = 'f'
            AND connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog')${
                databaseEdition === DatabaseEdition.TIMESCALE
                    ? timescaleFilters
                    : databaseEdition === DatabaseEdition.SUPABASE
                      ? supabaseFilters
                      : ''
            }
    ) AS x
), pk_info AS (
    SELECT array_to_string(array_agg(CONCAT('{"schema":"', schema_name, '"',
                                            ',"table":"', replace(pk_table, '"', ''), '"',
                                            ',"column":"', replace(pk_column, '"', ''), '"',
                                            ',"pk_def":"', replace(pk_def, '"', ''),
                                            '"}')), ',') AS pk_metadata
    FROM (
            SELECT connamespace::regnamespace::text AS schema_name,
                CASE
                    WHEN strpos(conrelid::regclass::text, '.') > 0
                    THEN split_part(conrelid::regclass::text, '.', 2)
                    ELSE conrelid::regclass::text
                END AS pk_table,
                unnest(string_to_array(substring(pg_get_constraintdef(oid) FROM '\\((.*?)\\)'), ',')) AS pk_column,
                pg_get_constraintdef(oid) as pk_def
            FROM
              pg_constraint
            WHERE
              contype = 'p'
              AND connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog')${
                  databaseEdition === DatabaseEdition.TIMESCALE
                      ? timescaleFilters
                      : databaseEdition === DatabaseEdition.SUPABASE
                        ? supabaseFilters
                        : ''
              }
    ) AS y
),
indexes_cols AS (
    SELECT tnsp.nspname                                                 AS schema_name,
          trel.relname                                                  AS table_name,
          pg_relation_size(tnsp.nspname || '.' || '"' || irel.relname || '"') AS index_size,
          irel.relname                                                  AS index_name,
          am.amname                                                     AS index_type,
          a.attname                                                     AS col_name,
          (CASE WHEN i.indisunique = TRUE THEN 'true' ELSE 'false' END)  AS is_unique,
          irel.reltuples                                                AS cardinality,
          1 + Array_position(i.indkey, a.attnum)                        AS column_position,
          CASE o.OPTION & 1 WHEN 1 THEN 'DESC' ELSE 'ASC' END           AS direction,
          CASE WHEN indpred IS NOT NULL THEN 'true' ELSE 'false' END    AS is_partial_index
    FROM pg_index AS i
        JOIN pg_class AS trel ON trel.oid = i.indrelid
        JOIN pg_namespace AS tnsp ON trel.relnamespace = tnsp.oid
        JOIN pg_class AS irel ON irel.oid = i.indexrelid
        JOIN pg_am AS am ON irel.relam = am.oid
        CROSS JOIN LATERAL unnest (i.indkey)
        WITH ORDINALITY AS c (colnum, ordinality) LEFT JOIN LATERAL unnest (i.indoption)
        WITH ORDINALITY AS o (option, ordinality)
        ON c.ordinality = o.ordinality JOIN pg_attribute AS a ON trel.oid = a.attrelid AND a.attnum = c.colnum
    WHERE tnsp.nspname NOT LIKE 'pg_%'
    GROUP BY tnsp.nspname, trel.relname, irel.relname, am.amname, i.indisunique, i.indexrelid, irel.reltuples, a.attname, Array_position(i.indkey, a.attnum), o.OPTION, i.indpred
),
cols AS (
    SELECT array_to_string(array_agg(CONCAT('{"schema":"', cols.table_schema,
                                            '","table":"', cols.table_name,
                                            '","name":"', cols.column_name,
                                            '","ordinal_position":"', cols.ordinal_position,
                                            '","type":"', LOWER(replace(cols.data_type, '"', '')),
                                            '","character_maximum_length":"', COALESCE(cols.character_maximum_length::text, 'null'),
                                            '","precision":',
                                                CASE
                                                    WHEN cols.data_type = 'numeric' OR cols.data_type = 'decimal'
                                                    THEN CONCAT('{"precision":', COALESCE(cols.numeric_precision::text, 'null'),
                                                                ',"scale":', COALESCE(cols.numeric_scale::text, 'null'), '}')
                                                    ELSE 'null'
                                                END,
                                            ',"nullable":', CASE WHEN (cols.IS_NULLABLE = 'YES') THEN 'true' ELSE 'false' END,
                                            ',"default":"', COALESCE(replace(replace(cols.column_default, '"', '\\"'), '\\x', '\\\\x'), ''),
                                            '","collation":"', COALESCE(cols.COLLATION_NAME, ''), '"}')), ',') AS cols_metadata
    FROM information_schema.columns cols
    WHERE cols.table_schema NOT IN ('information_schema', 'pg_catalog')${
        databaseEdition === DatabaseEdition.TIMESCALE
            ? timescaleColFilter
            : databaseEdition === DatabaseEdition.SUPABASE
              ? supabaseColFilter
              : ''
    }
), indexes_metadata AS (
    SELECT array_to_string(array_agg(CONCAT('{"schema":"', schema_name,
                                            '","table":"', table_name,
                                            '","name":"', index_name,
                                            '","column":"', replace(col_name :: TEXT, '"', E'"'),
                                            '","index_type":"', index_type,
                                            '","cardinality":', cardinality,
                                            ',"size":', index_size,
                                            ',"unique":', is_unique,
                                            ',"is_partial_index":', is_partial_index,
                                            ',"direction":"', LOWER(direction),
                                            '"}')), ',') AS indexes_metadata
    FROM indexes_cols x ${
        databaseEdition === DatabaseEdition.TIMESCALE
            ? timescaleIndexesFilter
            : databaseEdition === DatabaseEdition.SUPABASE
              ? supabaseIndexesFilter
              : ''
    }
), tbls AS (
    SELECT array_to_string(array_agg(CONCAT('{', '"schema":"', TABLE_SCHEMA, '",', '"table":"', TABLE_NAME, '",', '"rows":',
                                      COALESCE((SELECT s.n_live_tup
                                                FROM pg_stat_user_tables s
                                                WHERE tbls.TABLE_SCHEMA = s.schemaname AND tbls.TABLE_NAME = s.relname),
                                                0), ', "type":"', TABLE_TYPE, '",', '"engine":"",', '"collation":""}')),
                      ',') AS tbls_metadata
    FROM information_schema.tables tbls
    WHERE tbls.TABLE_SCHEMA NOT IN ('information_schema', 'pg_catalog') ${
        databaseEdition === DatabaseEdition.TIMESCALE
            ? timescaleTableFilter
            : databaseEdition === DatabaseEdition.SUPABASE
              ? supabaseTableFilter
              : ''
    }
), config AS (
    SELECT array_to_string(
                      array_agg(CONCAT('{"name":"', conf.name, '","value":"', replace(conf.setting, '"', E'"'), '"}')),
                      ',') AS config_metadata
    FROM pg_settings conf
), views AS (
    SELECT array_to_string(array_agg(CONCAT('{"schema":"', views.schemaname, '","view_name":"', viewname, '"}')),
                      ',') AS views_metadata
    FROM pg_views views
    WHERE views.schemaname NOT IN ('information_schema', 'pg_catalog') ${
        databaseEdition === DatabaseEdition.TIMESCALE
            ? timescaleViewsFilter
            : databaseEdition === DatabaseEdition.SUPABASE
              ? supabaseViewsFilter
              : ''
    }
)
SELECT CONCAT('{    "fk_info": [', COALESCE(fk_metadata, ''),
                    '], "pk_info": [', COALESCE(pk_metadata, ''),
                    '], "columns": [', COALESCE(cols_metadata, ''),
                    '], "indexes": [', COALESCE(indexes_metadata, ''),
                    '], "tables":[', COALESCE(tbls_metadata, ''),
                    '], "views":[', COALESCE(views_metadata, ''),
                    '], "database_name": "', CURRENT_DATABASE(), '', '", "version": "', '',
              '"}') AS " "
FROM fk_info${databaseEdition ? '_' + databaseEdition : ''}, pk_info, cols, indexes_metadata, tbls, config, views;
    `;

    return query;
};