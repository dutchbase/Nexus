#include <stdio.h>
#include <string.h>
#include <unistd.h>

int argon2id_hash_encoded(unsigned int, unsigned int, unsigned int,
  const void *, size_t, const void *, size_t, size_t, char *, size_t);
int argon2id_verify(const char *, const void *, size_t);

static int read_line(char *buffer, size_t size) {
  if (!fgets(buffer, size, stdin)) return 0;
  buffer[strcspn(buffer, "\r\n")] = 0;
  return 1;
}

int main(int argc, char **argv) {
  char password[4096];
  if (argc != 2 || !read_line(password, sizeof(password))) return 2;
  if (strcmp(argv[1], "hash") == 0) {
    unsigned char salt[16];
    FILE *random = fopen("/dev/urandom", "rb");
    if (!random || fread(salt, 1, sizeof(salt), random) != sizeof(salt)) return 3;
    fclose(random);
    char encoded[256];
    int result = argon2id_hash_encoded(2, 19456, 1, password, strlen(password),
      salt, sizeof(salt), 32, encoded, sizeof(encoded));
    if (result != 0) return result;
    puts(encoded);
    return 0;
  }
  if (strcmp(argv[1], "verify") == 0) {
    char encoded[512];
    if (!read_line(encoded, sizeof(encoded))) return 2;
    return argon2id_verify(encoded, password, strlen(password)) == 0 ? 0 : 1;
  }
  return 2;
}
