-- =========================================================
-- マイポケカ データベース設計（フェーズ1）
-- Supabase の「SQL Editor」に全文を貼り付けて「Run」してください。
-- 何度実行しても壊れないように書いてあります。
-- =========================================================

create extension if not exists pg_trgm;

-- ---------- カードマスター（全員が読める・書くのは取り込みプログラムだけ） ----------
create table if not exists public.card_sets (
  set_id        text primary key,
  set_name      text not null,
  release_date  date,
  card_count    integer,
  source_name   text not null default 'TCGdex',
  last_updated  timestamptz not null default now()
);

create table if not exists public.cards (
  card_id         text primary key,            -- 例: tcgdex:ja:SV8a-217（名前や番号だけを識別子にしない）
  card_name       text not null,
  card_number     text,                        -- 例: 217/187
  local_id        text,                        -- 例: 217
  set_id          text references public.card_sets(set_id) on update cascade,
  set_name        text,
  rarity          text,                        -- アプリで使う略号（SAR など）
  rarity_raw      text,                        -- 取得元の表記そのまま
  release_date    date,
  card_variant    text,
  image_url       text,                        -- 利用条件が確認できるまで画面には出さない
  source_name     text not null default 'TCGdex',
  source_card_id  text,
  name_norm       text,                        -- 検索用に正規化した名前
  last_updated    timestamptz not null default now()
);
create index if not exists cards_name_norm_trgm on public.cards using gin (name_norm gin_trgm_ops);
create index if not exists cards_set_idx on public.cards (set_id);
create index if not exists cards_rarity_idx on public.cards (rarity);
create index if not exists cards_local_id_idx on public.cards (local_id);

-- ---------- 相場（カード情報とは別のテーブル。種類を混ぜて平均しない） ----------
create table if not exists public.price_observations (
  id            bigint generated always as identity primary key,
  card_id       text not null references public.cards(card_id) on delete cascade,
  price_kind    text not null check (price_kind in ('shop_sell','shop_buy','market','graded')),
  condition     text not null default '指定なし',
  grader        text,
  grade         text,
  price_yen     integer not null check (price_yen >= 0),
  source_name   text not null,
  observed_at   timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists price_obs_card_idx on public.price_observations (card_id, price_kind, observed_at desc);

-- ---------- ここから利用者ごとのデータ（本人しか見られない） ----------
create table if not exists public.manual_cards (
  id            text primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_name     text not null,
  card_number   text,
  set_name      text,
  rarity        text,
  release_date  text,
  card_variant  text,
  linked_to     text,                        -- 正式データに紐付けたら入る（cards.card_id）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.wishes (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id     text not null,              -- cards.card_id または manual_cards.id
  qty         integer not null default 1 check (qty >= 1),
  target_yen  integer check (target_yen >= 0),
  priority    smallint not null default 2 check (priority between 1 and 3),
  memo        text,
  share_with_friends boolean not null default false,   -- 初期値は非公開
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.purchases (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id     text not null,
  price_yen   integer not null check (price_yen >= 0),   -- 1枚あたり
  qty         integer not null default 1 check (qty >= 1),
  shipping_yen integer not null default 0 check (shipping_yen >= 0),
  fee_yen     integer not null default 0 check (fee_yen >= 0),
  purchased_on date,
  store       text,
  condition   text,
  grader      text,
  grade       text,
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 自分で入力した参考価格（相場の自動取得とは別）
create table if not exists public.user_prices (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id     text not null,
  price_kind  text not null check (price_kind in ('market','shop_sell','shop_buy')),
  condition   text not null default '指定なし',
  grader      text,
  grade       text,
  price_yen   integer not null check (price_yen >= 0),
  source_note text,
  recorded_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.card_meta (
  id          text not null,               -- カードごとに1行（利用者が違えば同じidでもよい）
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_id     text not null,
  favorite    boolean not null default false,
  location    text,
  memo        text,
  album_ids   text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.albums (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 以前の版で作った「linked_to」の制約を外す（手動読み込みのカードにも紐付けられるように）
alter table public.manual_cards drop constraint if exists manual_cards_linked_to_fkey;

create index if not exists wishes_user_idx     on public.wishes (user_id);
create index if not exists purchases_user_idx  on public.purchases (user_id, purchased_on desc);
create index if not exists user_prices_user_idx on public.user_prices (user_id, card_id);
create index if not exists card_meta_user_idx  on public.card_meta (user_id);
create index if not exists manual_cards_user_idx on public.manual_cards (user_id);
create index if not exists albums_user_idx     on public.albums (user_id);

-- ---------- アクセス制御（RLS） ----------
alter table public.card_sets           enable row level security;
alter table public.cards               enable row level security;
alter table public.price_observations  enable row level security;
alter table public.manual_cards        enable row level security;
alter table public.wishes              enable row level security;
alter table public.purchases           enable row level security;
alter table public.user_prices         enable row level security;
alter table public.card_meta           enable row level security;
alter table public.albums              enable row level security;

-- カードマスターと相場：だれでも読める。書き込みのポリシーは作らない
-- （取り込みプログラムは service_role キーを使うので RLS の対象外）
drop policy if exists "read card_sets" on public.card_sets;
create policy "read card_sets" on public.card_sets for select using (true);
drop policy if exists "read cards" on public.cards;
create policy "read cards" on public.cards for select using (true);
drop policy if exists "read prices" on public.price_observations;
create policy "read prices" on public.price_observations for select using (true);

-- 利用者データ：本人だけが読み書きできる
do $$
declare t text;
begin
  foreach t in array array['manual_cards','wishes','purchases','user_prices','card_meta','albums'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- 更新日時を自動で入れる
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['manual_cards','wishes','purchases','user_prices','card_meta','albums'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
