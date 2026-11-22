alter table public.profiles
  add column if not exists phone text;

create unique index if not exists profiles_phone_normalized_key
  on public.profiles (regexp_replace(phone, '[^0-9]', '', 'g'))
  where nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '') is not null;
