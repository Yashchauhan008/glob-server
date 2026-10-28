-- migrate:up
-- Files were first saved with http://<server-ip>:3008/files, which browsers block on the https site.
-- The api is served over https at api.glob.yashchauhan.pro, so move the stored addresses there.
update files set endpoint = replace(endpoint, 'http://187.52.116.113:3008/files', 'https://api.glob.yashchauhan.pro/files')
  where endpoint like 'http://187.52.116.113:3008/files%';
update users set avatar_url = replace(avatar_url, 'http://187.52.116.113:3008/files', 'https://api.glob.yashchauhan.pro/files')
  where avatar_url like 'http://187.52.116.113:3008/files%';
update attachments set url = replace(url, 'http://187.52.116.113:3008/files', 'https://api.glob.yashchauhan.pro/files')
  where url like 'http://187.52.116.113:3008/files%';
update attachments set thumb_url = replace(thumb_url, 'http://187.52.116.113:3008/files', 'https://api.glob.yashchauhan.pro/files')
  where thumb_url like 'http://187.52.116.113:3008/files%';

-- migrate:down
-- (not reversible: the old http addresses were never usable on the https site)
