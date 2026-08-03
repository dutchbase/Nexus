UPDATE notification_providers
SET configuration_encrypted_json = jsonb_strip_nulls(jsonb_build_object(
  'base_url', CASE
    WHEN jsonb_typeof(configuration_encrypted_json->'base_url') = 'string'
      AND configuration_encrypted_json->>'base_url' <> ''
      AND configuration_encrypted_json->>'base_url' !~ '^([A-Za-z][A-Za-z0-9+._-]*:)?//[^/?#]*@'
    THEN configuration_encrypted_json->'base_url'
  END,
  'endpoint', CASE
    WHEN jsonb_typeof(configuration_encrypted_json->'endpoint') = 'string'
      AND configuration_encrypted_json->>'endpoint' <> ''
      AND configuration_encrypted_json->>'endpoint' !~ '^([A-Za-z][A-Za-z0-9+._-]*:)?//[^/?#]*@'
    THEN configuration_encrypted_json->'endpoint'
  END,
  'method', CASE
    WHEN configuration_encrypted_json->>'method' IN ('POST', 'PUT', 'PATCH')
    THEN configuration_encrypted_json->'method'
  END,
  'timeout_seconds', CASE
    WHEN jsonb_typeof(configuration_encrypted_json->'timeout_seconds') = 'number'
      AND (configuration_encrypted_json->>'timeout_seconds')::numeric BETWEEN 1 AND 60
    THEN configuration_encrypted_json->'timeout_seconds'
  END,
  'authentication', CASE
    WHEN jsonb_typeof(configuration_encrypted_json->'authentication') = 'object'
      AND configuration_encrypted_json->'authentication'->>'type' IN ('bearer', 'raw')
      AND configuration_encrypted_json->'authentication'->>'secret_reference' ~ '^DCC_NOTIFICATION_SECRET_[A-Za-z_][A-Za-z0-9_]*$'
    THEN jsonb_build_object(
      'type', configuration_encrypted_json->'authentication'->'type',
      'secret_reference', configuration_encrypted_json->'authentication'->'secret_reference'
    )
  END
));
