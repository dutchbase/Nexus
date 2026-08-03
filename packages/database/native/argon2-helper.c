#include <stdio.h>
#include <string.h>
#include <unistd.h>

int argon2id_hash_encoded(unsigned int, unsigned int, unsigned int,
  const void *, size_t, const void *, size_t, size_t, char *, size_t);
int argon2id_verify(const char *, const void *, size_t);

static int read_password(unsigned char *buffer, size_t size, size_t *length) {
  int byte;
  *length = 0;
  while ((byte = fgetc(stdin)) != EOF) {
    if (*length == size || byte == 0 || byte == '\r' || byte == '\n') return 0;
    buffer[(*length)++] = (unsigned char)byte;
  }
  return *length > 0 && !ferror(stdin);
}

int main(int argc, char **argv) {
  unsigned char password[4096];
  size_t password_length;
  if (argc < 2 || !read_password(password, sizeof(password), &password_length)) return 2;
  if (strcmp(argv[1], "hash") == 0) {
    if (argc != 2) return 2;
    unsigned char salt[16];
    FILE *random = fopen("/dev/urandom", "rb");
    if (!random || fread(salt, 1, sizeof(salt), random) != sizeof(salt)) return 3;
    fclose(random);
    char encoded[256];
    int result = argon2id_hash_encoded(2, 19456, 1, password, password_length,
      salt, sizeof(salt), 32, encoded, sizeof(encoded));
    if (result != 0) return result;
    puts(encoded);
    return 0;
  }
  if (strcmp(argv[1], "verify") == 0) {
    if (argc != 3) return 2;
    return argon2id_verify(argv[2], password, password_length) == 0 ? 0 : 1;
  }
  return 2;
}
